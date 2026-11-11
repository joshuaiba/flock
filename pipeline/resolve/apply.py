"""Apply entity-resolution decisions. The ONLY module that writes merges.

The agent and its tools never write to the knowledge graph; they return a
MergeDecision and this module decides what happens to it:

    merge,    confidence >= MERGE_CONFIDENCE     -> merge() now
    separate, confidence >= SEPARATE_CONFIDENCE  -> org_non_matches (never re-asked)
    anything else                                -> pending_merges, for human review

What a merge does (one transaction):
- The merged row is kept, with merged_into = the canonical row. Loaders find
  it by (source, source_id) and follow merged_into, so a nightly reload cannot
  resurrect it or pull its awards back (see load/postgres.py upsert_org).
- Its name and aliases are added to the canonical row's aliases; the canonical
  row takes its UEI if it had none.
- awards.recipient_id / agency_id, opportunities.agency_id, organization
  edges, and organization taggings/classifications are repointed. Edge (and
  tagging/classification) source_ids embed the org id, so they are rewritten
  to the new natural key; if the canonical row already has that edge the moved
  duplicate is deleted, and an edge that would become a self-loop is deleted.
- Rows previously merged into the merged row are re-rooted to the canonical
  row, so merged_into always points straight at a live row.
- Open pending_merges rows about the merged row are removed (the question no
  longer exists), and its org_non_matches are copied to the canonical row.
- Everything changed is written to org_merges.snapshot.

undo() restores exactly from that snapshot (edges come back with their
original ids, source_ids and timestamps) and records the pair in
org_non_matches so the nightly run does not immediately redo the merge. It
refuses if a later, still-active merge touches either row: undo those first.
Limitation: awards first loaded while the merge was active were attached to
the canonical row; after an undo the next load of their source moves
recipient_id back, but an `awarded_to` edge created in that window stays on
the canonical row.

Commit expectations: every function here runs inside `conn.transaction()`
(its own transaction on an idle connection, a savepoint otherwise). Callers
commit.
"""

from __future__ import annotations

import logging
from typing import Literal

import psycopg
from psycopg.types.json import Jsonb

from pipeline.resolve.models import CandidatePair, MergeDecision

log = logging.getLogger(__name__)

MERGE_CONFIDENCE = 0.9
SEPARATE_CONFIDENCE = 0.9

MergeSource = Literal["uei", "agent", "review"]
Action = Literal["merged", "non_match", "pending"]
ReviewAction = Literal["accepted", "rejected"]

# Tables whose rows point at an organization through (entity_type, entity_id)
# and carry the org id inside source_id.
_ENTITY_TABLES = ("taggings", "classifications")


class MergeError(Exception):
    """A merge, undo or review action that cannot be applied as asked."""


def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def live_root(conn: psycopg.Connection, org_id: int) -> int:
    """Follow merged_into to the live row. Raises MergeError for an unknown id."""
    seen = set()
    current = org_id
    while True:
        if current in seen:
            raise MergeError(f"merged_into cycle at organization {current}")
        seen.add(current)
        row = conn.execute(
            "SELECT merged_into FROM organizations WHERE id = %s", (current,)
        ).fetchone()
        if row is None:
            raise MergeError(f"no organization with id {org_id}")
        if row[0] is None:
            return current
        current = row[0]


def _rows(conn: psycopg.Connection, table: str, where: str, params: tuple) -> list[dict]:
    """Full rows as JSON objects (Postgres does the encoding, so restoring is exact)."""
    return [
        r[0]
        for r in conn.execute(
            f"SELECT to_jsonb(t) FROM {table} t WHERE {where} ORDER BY 1", params
        ).fetchall()
    ]


def _restore_rows(conn: psycopg.Connection, table: str, rows: list[dict], key: str = "id") -> None:
    """Put snapshot rows back exactly, replacing whatever now has their keys."""
    for row in rows:
        conn.execute(f"DELETE FROM {table} WHERE {key} = %s", (row[key],))
        conn.execute(
            f"INSERT INTO {table} OVERRIDING SYSTEM VALUE"
            f" SELECT * FROM jsonb_populate_record(NULL::{table}, %s)"
            " ON CONFLICT DO NOTHING",
            (Jsonb(row),),
        )


def _move_edges(conn: psycopg.Connection, other: int, canonical: int) -> list[dict]:
    before = _rows(
        conn,
        "edges",
        "(t.src_type = 'organization' AND t.src_id = %s)"
        " OR (t.dst_type = 'organization' AND t.dst_id = %s)",
        (other, other),
    )
    for e in before:
        src_id = (
            canonical if e["src_type"] == "organization" and e["src_id"] == other else e["src_id"]
        )
        dst_id = (
            canonical if e["dst_type"] == "organization" and e["dst_id"] == other else e["dst_id"]
        )
        self_loop = e["src_type"] == e["dst_type"] == "organization" and src_id == dst_id
        # Loaders build source_id as the edge's natural key; keep it in step.
        old_key = f"{e['src_type']}:{e['src_id']}:{e['rel']}:{e['dst_type']}:{e['dst_id']}"
        new_key = f"{e['src_type']}:{src_id}:{e['rel']}:{e['dst_type']}:{dst_id}"
        source_id = new_key if e["source_id"] == old_key else e["source_id"]
        duplicate = (
            source_id != e["source_id"]
            and conn.execute(
                "SELECT 1 FROM edges WHERE source = %s AND source_id = %s",
                (e["source"], source_id),
            ).fetchone()
            is not None
        )
        if self_loop or duplicate:
            conn.execute("DELETE FROM edges WHERE id = %s", (e["id"],))
        else:
            conn.execute(
                "UPDATE edges SET src_id = %s, dst_id = %s, source_id = %s WHERE id = %s",
                (src_id, dst_id, source_id, e["id"]),
            )
    return before


def _move_entity_rows(
    conn: psycopg.Connection, table: str, other: int, canonical: int
) -> list[dict]:
    before = _rows(conn, table, "t.entity_type = 'organization' AND t.entity_id = %s", (other,))
    old_prefix, new_prefix = f"organization:{other}", f"organization:{canonical}"
    for r in before:
        sid = r["source_id"]
        if sid == old_prefix or sid.startswith(old_prefix + ":"):
            new_sid = new_prefix + sid[len(old_prefix) :]
        else:
            new_sid = sid
        duplicate = (
            new_sid != sid
            and conn.execute(
                f"SELECT 1 FROM {table} WHERE source = %s AND source_id = %s",
                (r["source"], new_sid),
            ).fetchone()
            is not None
        )
        if duplicate:
            conn.execute(f"DELETE FROM {table} WHERE id = %s", (r["id"],))
        else:
            conn.execute(
                f"UPDATE {table} SET entity_id = %s, source_id = %s WHERE id = %s",
                (canonical, new_sid, r["id"]),
            )
    return before


def _ids(conn: psycopg.Connection, sql: str, params: tuple) -> list[int]:
    return sorted(r[0] for r in conn.execute(sql, params).fetchall())


def merge(
    conn: psycopg.Connection,
    canonical_id: int,
    other_id: int,
    *,
    confidence: float | None,
    source: MergeSource,
    agent_run_id: int | None = None,
) -> int:
    """Merge organization `other_id` into `canonical_id`; returns org_merges.id.

    Either id may itself already be merged: both are resolved to their live
    rows first. Raises MergeError if they are (already) the same row.
    """
    with conn.transaction():
        canonical = live_root(conn, canonical_id)
        other = live_root(conn, other_id)
        if canonical == other:
            raise MergeError(
                f"organizations {canonical_id} and {other_id} are already one row ({canonical})"
            )
        orgs = {
            r[0]: r
            for r in conn.execute(
                "SELECT id, canonical_name, uei, aliases FROM organizations"
                " WHERE id IN (%s, %s) ORDER BY id FOR UPDATE",
                (canonical, other),
            ).fetchall()
        }
        _, c_name, c_uei, c_aliases = orgs[canonical]
        _, o_name, o_uei, o_aliases = orgs[other]

        snapshot: dict = {
            "version": 1,
            "canonical": {"id": canonical, "uei": c_uei, "aliases": list(c_aliases)},
            "merged": {"id": other},
        }

        aliases = sorted({*c_aliases, *o_aliases, o_name} - {c_name, ""})
        conn.execute(
            "UPDATE organizations SET aliases = %s, uei = COALESCE(uei, %s) WHERE id = %s",
            (aliases, o_uei, canonical),
        )

        snapshot["awards_recipient"] = _ids(
            conn,
            "UPDATE awards SET recipient_id = %s WHERE recipient_id = %s RETURNING id",
            (canonical, other),
        )
        snapshot["awards_agency"] = _ids(
            conn,
            "UPDATE awards SET agency_id = %s WHERE agency_id = %s RETURNING id",
            (canonical, other),
        )
        snapshot["opportunities_agency"] = _ids(
            conn,
            "UPDATE opportunities SET agency_id = %s WHERE agency_id = %s RETURNING id",
            (canonical, other),
        )
        snapshot["edges"] = _move_edges(conn, other, canonical)
        for table in _ENTITY_TABLES:
            snapshot[table] = _move_entity_rows(conn, table, other, canonical)

        # Open review questions about the merged row no longer make sense.
        snapshot["pending_merges"] = _rows(
            conn,
            "pending_merges",
            "t.reviewed_at IS NULL AND (t.left_org_id = %s OR t.right_org_id = %s)",
            (other, other),
        )
        conn.execute(
            "DELETE FROM pending_merges"
            " WHERE reviewed_at IS NULL AND (left_org_id = %s OR right_org_id = %s)",
            (other, other),
        )

        # A recorded "these two differ" about this very pair is superseded.
        left, right = _pair(canonical, other)
        snapshot["non_matches_deleted"] = _rows(
            conn, "org_non_matches", "t.left_org_id = %s AND t.right_org_id = %s", (left, right)
        )
        conn.execute(
            "DELETE FROM org_non_matches WHERE left_org_id = %s AND right_org_id = %s",
            (left, right),
        )
        # What was known to differ from the merged row also differs from the canonical row.
        added = []
        for nl, nr, conf, reasoning, run_id in conn.execute(
            "SELECT left_org_id, right_org_id, confidence, reasoning, agent_run_id"
            " FROM org_non_matches WHERE left_org_id = %s OR right_org_id = %s",
            (other, other),
        ).fetchall():
            third = nr if nl == other else nl
            if third == canonical:
                continue
            a, b = _pair(canonical, third)
            inserted = conn.execute(
                """INSERT INTO org_non_matches (left_org_id, right_org_id, confidence,
                                                reasoning, agent_run_id)
                   VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING 1""",
                (a, b, conf, reasoning, run_id),
            ).fetchone()
            if inserted:
                added.append([a, b])
        snapshot["non_matches_added"] = added

        snapshot["rerooted"] = _ids(
            conn,
            "UPDATE organizations SET merged_into = %s WHERE merged_into = %s RETURNING id",
            (canonical, other),
        )
        conn.execute("UPDATE organizations SET merged_into = %s WHERE id = %s", (canonical, other))

        merge_id = conn.execute(
            """INSERT INTO org_merges (canonical_org_id, merged_org_id, confidence,
                                       decision_source, agent_run_id, snapshot)
               VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
            (canonical, other, confidence, source, agent_run_id, Jsonb(snapshot)),
        ).fetchone()[0]
    log.info("merged organization %s into %s (%s, merge %s)", other, canonical, source, merge_id)
    return merge_id


def undo(conn: psycopg.Connection, merge_id: int) -> None:
    """Reverse merge `merge_id` from its snapshot and remember the pair as a non-match."""
    with conn.transaction():
        row = conn.execute(
            "SELECT canonical_org_id, merged_org_id, snapshot, undone_at"
            " FROM org_merges WHERE id = %s FOR UPDATE",
            (merge_id,),
        ).fetchone()
        if row is None:
            raise MergeError(f"no merge with id {merge_id}")
        canonical, other, snap, undone_at = row
        if undone_at is not None:
            raise MergeError(f"merge {merge_id} was already undone at {undone_at:%Y-%m-%d %H:%M}")
        later = _ids(
            conn,
            """SELECT id FROM org_merges
               WHERE id > %s AND undone_at IS NULL
                 AND (canonical_org_id = ANY(%s) OR merged_org_id = ANY(%s))""",
            (merge_id, [canonical, other], [canonical, other]),
        )
        if later:
            raise MergeError(
                f"merge {merge_id} cannot be undone yet: later merge(s) "
                f"{', '.join(map(str, later))} involve the same organizations; undo those first"
            )

        conn.execute("UPDATE organizations SET merged_into = NULL WHERE id = %s", (other,))
        conn.execute(
            "UPDATE organizations SET merged_into = %s WHERE id = ANY(%s) AND merged_into = %s",
            (other, snap["rerooted"], canonical),
        )
        conn.execute(
            "UPDATE organizations SET aliases = %s, uei = %s WHERE id = %s",
            (snap["canonical"]["aliases"], snap["canonical"]["uei"], canonical),
        )
        conn.execute(
            "UPDATE awards SET recipient_id = %s WHERE id = ANY(%s) AND recipient_id = %s",
            (other, snap["awards_recipient"], canonical),
        )
        conn.execute(
            "UPDATE awards SET agency_id = %s WHERE id = ANY(%s) AND agency_id = %s",
            (other, snap["awards_agency"], canonical),
        )
        conn.execute(
            "UPDATE opportunities SET agency_id = %s WHERE id = ANY(%s) AND agency_id = %s",
            (other, snap["opportunities_agency"], canonical),
        )
        _restore_rows(conn, "edges", snap["edges"])
        for table in _ENTITY_TABLES:
            _restore_rows(conn, table, snap[table])
        _restore_rows(conn, "pending_merges", snap["pending_merges"])
        for a, b in snap["non_matches_added"]:
            conn.execute(
                "DELETE FROM org_non_matches WHERE left_org_id = %s AND right_org_id = %s", (a, b)
            )
        for nm in snap["non_matches_deleted"]:
            conn.execute(
                "INSERT INTO org_non_matches"
                " SELECT * FROM jsonb_populate_record(NULL::org_non_matches, %s)"
                " ON CONFLICT DO NOTHING",
                (Jsonb(nm),),
            )
        conn.execute("UPDATE org_merges SET undone_at = now() WHERE id = %s", (merge_id,))
        _record_non_match(conn, canonical, other, None, f"merge {merge_id} was undone", None)
    log.info("undid merge %s (organization %s restored)", merge_id, other)


def _record_non_match(conn, a: int, b: int, confidence, reasoning, agent_run_id) -> None:
    left, right = _pair(a, b)
    conn.execute(
        """INSERT INTO org_non_matches (left_org_id, right_org_id, confidence, reasoning,
                                        agent_run_id)
           VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
        (left, right, confidence, reasoning, agent_run_id),
    )


def planned_action(pair: CandidatePair, decision: MergeDecision) -> Action:
    """What apply_decision will do with this decision (pure; no database)."""
    ids = {pair.left_org_id, pair.right_org_id}
    if (
        decision.decision == "merge"
        and decision.confidence >= MERGE_CONFIDENCE
        and decision.canonical_org_id in ids
    ):
        return "merged"
    if decision.decision == "separate" and decision.confidence >= SEPARATE_CONFIDENCE:
        return "non_match"
    return "pending"


def apply_decision(
    conn: psycopg.Connection,
    pair: CandidatePair,
    decision: MergeDecision,
    *,
    agent_run_id: int | None,
    dry_run: bool = False,
) -> Action:
    """Act on the agent's decision for `pair`; returns what was (or would be) done."""
    action = planned_action(pair, decision)
    if dry_run:
        return action
    with conn.transaction():
        if action == "merged":
            canonical = decision.canonical_org_id
            other = pair.right_org_id if canonical == pair.left_org_id else pair.left_org_id
            merge(
                conn,
                canonical,
                other,
                confidence=decision.confidence,
                source="agent",
                agent_run_id=agent_run_id,
            )
        elif action == "non_match":
            _record_non_match(
                conn,
                pair.left_org_id,
                pair.right_org_id,
                decision.confidence,
                decision.reasoning,
                agent_run_id,
            )
        else:
            left, right = _pair(pair.left_org_id, pair.right_org_id)
            canonical = (
                decision.canonical_org_id if decision.canonical_org_id in (left, right) else None
            )
            conn.execute(
                """INSERT INTO pending_merges (left_org_id, right_org_id, decision,
                       canonical_org_id, confidence, evidence, reasoning, agent_run_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (left_org_id, right_org_id) WHERE reviewed_at IS NULL
                   DO UPDATE SET decision = EXCLUDED.decision,
                       canonical_org_id = EXCLUDED.canonical_org_id,
                       confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,
                       reasoning = EXCLUDED.reasoning, agent_run_id = EXCLUDED.agent_run_id,
                       created_at = now()""",
                (
                    left,
                    right,
                    decision.decision,
                    canonical,
                    decision.confidence,
                    Jsonb([e.model_dump(mode="json") for e in decision.evidence]),
                    decision.reasoning,
                    agent_run_id,
                ),
            )
    return action


def resolve_pending(
    conn: psycopg.Connection,
    pending_id: int,
    action: ReviewAction,
    canonical_org_id: int | None = None,
) -> int | None:
    """Record a reviewer's verdict on a pending_merges row.

    'accepted' means "these are the same organization": the pair is merged
    (returns org_merges.id). The surviving row is `canonical_org_id` if given,
    else the one the agent proposed; if neither exists MergeError is raised.
    'rejected' means "these are different": the pair goes to org_non_matches
    and is never proposed again (returns None).
    """
    with conn.transaction():
        row = conn.execute(
            "SELECT left_org_id, right_org_id, canonical_org_id, confidence, reasoning,"
            " agent_run_id, reviewed_at FROM pending_merges WHERE id = %s FOR UPDATE",
            (pending_id,),
        ).fetchone()
        if row is None:
            raise MergeError(f"no pending merge with id {pending_id}")
        left, right, proposed, confidence, reasoning, run_id, reviewed_at = row
        if reviewed_at is not None:
            raise MergeError(f"pending merge {pending_id} was already reviewed")
        if action not in ("accepted", "rejected"):
            raise MergeError(f"unknown review action: {action!r}")

        canonical = canonical_org_id if canonical_org_id is not None else proposed
        if action == "accepted":
            if canonical is None:
                raise MergeError(
                    f"pending merge {pending_id} has no proposed canonical organization; "
                    f"pass canonical_org_id ({left} or {right})"
                )
            if canonical not in (left, right):
                raise MergeError(f"canonical_org_id must be {left} or {right}, not {canonical}")
        # Mark it reviewed first: merge() clears *open* questions about the merged row.
        conn.execute(
            "UPDATE pending_merges SET reviewed_at = now(), reviewer_action = %s WHERE id = %s",
            (action, pending_id),
        )
        if action == "rejected":
            _record_non_match(conn, left, right, None, "rejected in review", run_id)
            return None
        other = right if canonical == left else left
        return merge(
            conn, canonical, other, confidence=confidence, source="review", agent_run_id=run_id
        )
