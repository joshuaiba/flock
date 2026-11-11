"""One entity-resolution pass: block -> auto-merge by UEI -> agent -> apply.

    stats = runner.run(conn, limit=50, dry_run=False)

Commits as it goes: after every UEI auto-merge, after every agent run (so the
agent_runs row, the http_cache rows and the SAM.gov quota count survive even
when the run failed), and after every applied decision. A failed or
over-budget run applies nothing for its pair. One pair (or one auto-merge)
going wrong, whatever the exception, is rolled back, counted in `failed` and
listed in `failures`; the pass carries on with the next one.

dry_run: the agent still runs (that is how cost per decision is measured) and
agent_runs / http_cache rows are still written, but no merge, pending or
non-match rows are. The counts then say what *would* have happened.
"""

from __future__ import annotations

import logging

import psycopg

from pipeline.agents import run_log, tracing
from pipeline.extract.llm import Provider
from pipeline.http import PoliteClient
from pipeline.resolve import agent, apply, candidates
from pipeline.resolve.deps import ResolveDeps

log = logging.getLogger(__name__)

ERROR_CHARS = 300


def _usage(conn: psycopg.Connection, since_id: int) -> dict[str, int]:
    """Totals over the resolver's agent_runs rows written after `since_id`
    (includes rows for attempts that were retried after a 429/5xx)."""
    row = conn.execute(
        """SELECT count(*), coalesce(sum(requests), 0), coalesce(sum(input_tokens), 0),
                  coalesce(sum(output_tokens), 0),
                  coalesce(sum(jsonb_array_length(tool_calls)), 0)
           FROM agent_runs WHERE agent_name = %s AND id > %s""",
        (agent.AGENT_NAME, since_id),
    ).fetchone()
    return {
        "runs": row[0],
        "requests": int(row[1]),
        "input_tokens": int(row[2]),
        "output_tokens": int(row[3]),
        "total_tokens": int(row[2]) + int(row[3]),
        "tool_calls": int(row[4]),
    }


def _failure(ref: str, run_id: int | None, error: str) -> dict:
    return {"input_ref": ref, "run_id": run_id, "error": run_log.redact(error)[:ERROR_CHARS]}


def _settle(conn: psycopg.Connection) -> None:
    """Commit what can be committed (audit and cache rows); roll back a failed transaction."""
    if conn.info.transaction_status == psycopg.pq.TransactionStatus.INERROR:
        conn.rollback()
    else:
        conn.commit()


def _both_live(conn: psycopg.Connection, a: int, b: int) -> bool:
    n = conn.execute(
        "SELECT count(*) FROM organizations WHERE id IN (%s, %s) AND merged_into IS NULL", (a, b)
    ).fetchone()[0]
    return n == 2


def run(
    conn: psycopg.Connection,
    *,
    limit: int,
    dry_run: bool = False,
    provider: Provider | None = None,
    http: PoliteClient | None = None,
) -> dict:
    """Resolve up to `limit` candidate pairs. Returns JSON-serializable stats:

    dry_run        bool; when true the action counts below are "would have"
    auto_merged    organizations merged because they share a UEI (no agent)
    candidates     name pairs sent to the agent
    runs           agent_runs rows written (one per attempt)
    merged         agent decisions applied as merges
    non_matches    confident "separate" decisions recorded
    pending        decisions queued for human review this run
    failed         pairs with no decision (model error, tool error, budget
                   exceeded) or whose decision could not be applied, plus UEI
                   auto-merges that hit a database error
    skipped        pairs dropped because an earlier merge in this run made them stale
    stopped        only present when the pass ended early (model daily quota spent)
    failures       [{input_ref, run_id, error}] for those
    requests, input_tokens, output_tokens, total_tokens, tool_calls
                   usage totals for this run
    pending_total  open pending_merges rows after this run
    """
    tracing.configure_tracing()
    out: dict = {
        "dry_run": dry_run,
        "auto_merged": 0,
        "candidates": 0,
        "merged": 0,
        "non_matches": 0,
        "pending": 0,
        "failed": 0,
        "skipped": 0,
        "failures": [],
    }
    since_id = conn.execute("SELECT coalesce(max(id), 0) FROM agent_runs").fetchone()[0]

    autos = candidates.uei_auto_merges(conn)
    conn.commit()  # end the read transaction, so each merge below is its own
    for auto in autos:
        if not dry_run:
            try:
                apply.merge(
                    conn, auto.canonical_org_id, auto.other_org_id, confidence=1.0, source="uei"
                )
                conn.commit()
            except apply.MergeError as e:  # e.g. already merged via another row in the group
                conn.rollback()
                log.warning("UEI auto-merge %s skipped: %s", auto, e)
                continue
            except psycopg.Error as e:  # e.g. a deadlock with a concurrent loader
                conn.rollback()
                log.error("UEI auto-merge %s failed: %s", auto, e)
                out["failed"] += 1
                out["failures"].append(
                    _failure(
                        f"org:{auto.canonical_org_id}:{auto.other_org_id}",
                        None,
                        f"UEI auto-merge failed: {type(e).__name__}: {e}",
                    )
                )
                continue
        out["auto_merged"] += 1

    pairs = candidates.name_pairs(conn, limit=limit)
    out["candidates"] = len(pairs)
    conn.commit()

    if pairs:
        provider = provider or agent.default_provider()
        # max_retries is low on purpose: every retry is a request against the
        # SAM.gov daily quota that the http_requests log cannot count.
        client = http or PoliteClient(min_interval=1.0, max_retries=1)
        try:
            deps = ResolveDeps.from_settings(conn, client)
            for pair in pairs:
                ref = agent.input_ref(pair)
                if not _both_live(conn, pair.left_org_id, pair.right_org_id):
                    # One side was merged earlier in this run; the pair is stale and
                    # will be re-proposed against the surviving row next time.
                    out["skipped"] += 1
                    continue
                try:
                    outcome = agent.decide(pair, deps, provider=provider)
                except Exception as e:  # not KeyboardInterrupt: a tool or driver bug
                    # decide() turns agent errors into an Outcome; anything else
                    # (a tool raising, a database error) must not sink the pass.
                    log.exception("resolver crashed for %s", ref)
                    _settle(conn)  # keeps the audit row unless the transaction is dead
                    out["failed"] += 1
                    out["failures"].append(_failure(ref, None, f"{type(e).__name__}: {e}"))
                    continue
                finally:
                    _settle(conn)  # keep the audit row, cache rows and quota count
                if outcome.decision is None:
                    out["failed"] += 1
                    out["failures"].append(_failure(ref, outcome.run_id, outcome.error or ""))
                    if provider.exhausted:
                        # The model's daily quota is spent: every further pair
                        # would fail the same way. Stop; they are re-proposed
                        # next run.
                        log.error("model quota exhausted; stopping the resolve pass")
                        out["stopped"] = "model daily quota exhausted"
                        break
                    continue
                try:
                    action = apply.apply_decision(
                        conn, pair, outcome.decision, agent_run_id=outcome.run_id, dry_run=dry_run
                    )
                    conn.commit()
                except Exception as e:
                    conn.rollback()
                    log.error("could not apply decision for %s: %s", ref, e)
                    out["failed"] += 1
                    out["failures"].append(
                        _failure(ref, outcome.run_id, f"apply failed: {type(e).__name__}: {e}")
                    )
                    continue
                out[
                    {"merged": "merged", "non_match": "non_matches", "pending": "pending"}[action]
                ] += 1
        finally:
            if http is None:
                client.close()

    out.update(_usage(conn, since_id))
    out["pending_total"] = conn.execute(
        "SELECT count(*) FROM pending_merges WHERE reviewed_at IS NULL"
    ).fetchone()[0]
    conn.commit()
    return out
