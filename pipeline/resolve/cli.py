"""Entity-resolution command line.

    uv run python -m pipeline.resolve run [--limit 50] [--dry-run]
    uv run python -m pipeline.resolve review [--list | --accept ID | --reject ID]
                                             [--canonical ORG_ID]
    uv run python -m pipeline.resolve merges [--limit 20]
    uv run python -m pipeline.resolve undo MERGE_ID

run     One resolver pass (runner.run). Emits a stats JSON line on stdout via
        pipeline.stats (step "resolve") and a human summary on stderr. With
        --dry-run the agent still runs, so tokens are spent and agent_runs /
        http_cache rows are written, but nothing is merged, queued or
        recorded as a non-match; the summary's per-decision averages are the
        cost estimate.
review  Without flags: prints the open pending_merges and asks about each one:
        accept (same organization: merge), reject (different: never ask
        again), skip, quit. --list only prints. --accept / --reject act on one
        row without prompting.
merges  Recent merges with their ids, for `undo`.
undo    Reverse one merge from its snapshot.

Exit codes: 0 on success. `run` exits 2 when pairs were sent to the agent and
every one of them failed (same convention as dod_contracts: the CI step shows
as failed without anything being half-applied). `review --accept/--reject` and
`undo` exit 1 when the action is refused (unknown id, already reviewed, a
later merge in the way).
"""

from __future__ import annotations

import argparse
import logging
import sys
import textwrap
from collections.abc import Callable
from typing import TextIO

import psycopg

from pipeline import stats
from pipeline.db import connect
from pipeline.extract.llm import Provider
from pipeline.http import PoliteClient
from pipeline.resolve import apply, runner

log = logging.getLogger(__name__)

EXIT_ALL_FAILED = 2
EXIT_REFUSED = 1
WIDTH = 100

Reader = Callable[[str], str]  # prompt -> answer; raises EOFError when input ends


# ----------------------------------------------------------------------- run


def decided_pairs(st: dict) -> int:
    """Pairs that were actually sent to the agent in this run."""
    return st["candidates"] - st["skipped"]


def summarize_run(st: dict) -> str:
    would = "would be " if st["dry_run"] else ""
    lines = []
    if st["dry_run"]:
        lines.append(
            "DRY RUN: nothing was merged, queued or recorded. Counts are what would happen."
        )
    lines += [
        f"auto-merged by UEI: {st['auto_merged']}",
        f"pairs sent to the agent: {decided_pairs(st)}"
        + (f" ({st['skipped']} skipped as stale)" if st["skipped"] else ""),
        f"  {would}merged: {st['merged']}",
        f"  {would}queued for review: {st['pending']}",
        f"  {would}recorded as different: {st['non_matches']}",
        f"  failed: {st['failed']}",
        f"usage: {st['total_tokens']} tokens ({st['input_tokens']} in, {st['output_tokens']} out), "
        f"{st['requests']} requests, {st['tool_calls']} tool calls",
    ]
    n = decided_pairs(st)
    if n:
        lines.append(
            f"per decision: {st['total_tokens'] / n:.0f} tokens, "
            f"{st['tool_calls'] / n:.1f} tool calls, {st['requests'] / n:.1f} requests"
        )
    for f in st["failures"]:
        lines.append(f"  failed {f['input_ref']} (run {f['run_id']}): {f['error']}")
    lines.append(f"open pending merges: {st['pending_total']}")
    return "\n".join(lines)


def cmd_run(
    conn: psycopg.Connection,
    *,
    limit: int,
    dry_run: bool,
    err: TextIO,
    provider: Provider | None = None,
    http: PoliteClient | None = None,
) -> int:
    st = runner.run(conn, limit=limit, dry_run=dry_run, provider=provider, http=http)
    stats.emit("resolve", st)
    print(summarize_run(st), file=err)
    n = decided_pairs(st)
    return EXIT_ALL_FAILED if n and st["failed"] >= n else 0


# -------------------------------------------------------------------- review

PENDING_SQL = """
SELECT p.id, p.left_org_id, l.canonical_name, l.uei,
       p.right_org_id, r.canonical_name, r.uei,
       p.decision, p.canonical_org_id, p.confidence, p.reasoning, p.evidence, p.created_at
FROM pending_merges p
JOIN organizations l ON l.id = p.left_org_id
JOIN organizations r ON r.id = p.right_org_id
WHERE p.reviewed_at IS NULL {extra}
ORDER BY p.confidence DESC NULLS LAST, p.id
"""
_COLS = [
    "id",
    "left_id",
    "left_name",
    "left_uei",
    "right_id",
    "right_name",
    "right_uei",
    "decision",
    "canonical",
    "confidence",
    "reasoning",
    "evidence",
    "created_at",
]


def pending_rows(conn: psycopg.Connection, pending_id: int | None = None) -> list[dict]:
    extra, params = ("AND p.id = %s", (pending_id,)) if pending_id is not None else ("", ())
    rows = conn.execute(PENDING_SQL.format(extra=extra), params).fetchall()
    return [dict(zip(_COLS, r, strict=True)) for r in rows]


def _wrap(label: str, text: str) -> list[str]:
    return textwrap.wrap(text, WIDTH, initial_indent=label, subsequent_indent=" " * len(label)) or [
        label.rstrip()
    ]


def _org_line(n: int, org_id: int, name: str, uei: str | None, keep: bool) -> str:
    return f"  [{n}] #{org_id:<8} {name}   UEI {uei or '-'}" + (
        "   <- agent would keep" if keep else ""
    )


def format_pending(row: dict) -> str:
    conf = "-" if row["confidence"] is None else f"{row['confidence']:.2f}"
    lines = [
        "=" * WIDTH,
        f"pending #{row['id']}   agent says: {row['decision']}   confidence {conf}   "
        f"{row['created_at']:%Y-%m-%d}",
        _org_line(1, row["left_id"], row["left_name"], row["left_uei"],
                  row["canonical"] == row["left_id"]),
        _org_line(2, row["right_id"], row["right_name"], row["right_uei"],
                  row["canonical"] == row["right_id"]),
    ]  # fmt: skip
    lines += _wrap("  reasoning: ", row["reasoning"] or "-")
    evidence = row["evidence"] or []
    if not evidence:
        lines.append("  evidence:  none")
    for e in evidence:
        lines += _wrap(
            f"  evidence:  [{e.get('source', '?')}, supports {e.get('supports', '?')}] ",
            str(e.get("snippet", "")),
        )
        if e.get("url"):
            lines.append(f"             {e['url']}")
    return "\n".join(lines)


def print_pending(conn: psycopg.Connection, out: TextIO) -> int:
    rows = pending_rows(conn)
    for row in rows:
        print(format_pending(row), file=out)
    print(f"{len(rows)} pending merge(s) to review." if rows else "No pending merges.", file=out)
    return len(rows)


def review_one(
    conn: psycopg.Connection,
    pending_id: int,
    action: apply.ReviewAction,
    canonical_org_id: int | None,
    out: TextIO,
) -> bool:
    """Apply one verdict and commit. Prints the outcome; False if it was refused."""
    try:
        merge_id = apply.resolve_pending(conn, pending_id, action, canonical_org_id)
    except apply.MergeError as e:
        conn.rollback()
        print(f"Not applied: {e}", file=out)
        return False
    conn.commit()
    if action == "accepted":
        print(
            f"Accepted #{pending_id}: merged (merge {merge_id}; `undo {merge_id}` reverses it).",
            file=out,
        )
    else:
        print(f"Rejected #{pending_id}: recorded as different organizations.", file=out)
    return True


def _ask_canonical(row: dict, read: Reader, out: TextIO) -> int | None:
    answer = read("  Keep which record as the surviving one? [1/2, anything else skips] ").strip()
    if answer == "1":
        return row["left_id"]
    if answer == "2":
        return row["right_id"]
    print("  Skipped (no record chosen).", file=out)
    return None


def review_interactive(conn: psycopg.Connection, *, read: Reader, out: TextIO) -> dict:
    """Walk the open pending merges, asking about each. Returns counts."""
    counts = {"accepted": 0, "rejected": 0, "skipped": 0}
    rows = pending_rows(conn)
    conn.commit()
    if not rows:
        print("No pending merges.", file=out)
        return counts
    print(
        f"{len(rows)} pending merge(s). accept = same organization (merge); "
        "reject = different (never asked again).",
        file=out,
    )
    try:
        for i, listed in enumerate(rows, 1):
            # An earlier accept may have merged one side away and closed this question.
            current = pending_rows(conn, listed["id"])
            conn.commit()
            if not current:
                print(
                    f"pending #{listed['id']} was closed by an earlier merge; moving on.", file=out
                )
                continue
            row = current[0]
            print(format_pending(row), file=out)
            while True:
                answer = read(f"({i}/{len(rows)}) [a]ccept / [r]eject / [s]kip / [q]uit: ")
                answer = answer.strip().lower()[:1]
                if answer in ("a", "r", "s", "q"):
                    break
                print("  Please answer a, r, s or q.", file=out)
            if answer == "q":
                break
            if answer == "s":
                counts["skipped"] += 1
                continue
            if answer == "r":
                counts["rejected"] += review_one(conn, row["id"], "rejected", None, out)
                continue
            canonical = row["canonical"] or _ask_canonical(row, read, out)
            if canonical is None:
                counts["skipped"] += 1
                continue
            counts["accepted"] += review_one(conn, row["id"], "accepted", canonical, out)
    except (EOFError, KeyboardInterrupt):
        conn.rollback()
        print("\nStopped.", file=out)
    print(
        f"Done: {counts['accepted']} accepted, {counts['rejected']} rejected, "
        f"{counts['skipped']} skipped.",
        file=out,
    )
    return counts


# ------------------------------------------------------------ merges / undo


def print_merges(conn: psycopg.Connection, out: TextIO, limit: int = 20) -> int:
    rows = conn.execute(
        """SELECT m.id, o.id, o.canonical_name, c.id, c.canonical_name, m.decision_source,
                  m.confidence, m.merged_at, m.undone_at
           FROM org_merges m
           JOIN organizations o ON o.id = m.merged_org_id
           JOIN organizations c ON c.id = m.canonical_org_id
           ORDER BY m.id DESC LIMIT %s""",
        (limit,),
    ).fetchall()
    if not rows:
        print("No merges recorded.", file=out)
        return 0
    print(
        f"{'merge':>6}  {'source':<6}  {'conf':>4}  {'merged at':<16}  {'state':<6}  what", file=out
    )
    for mid, oid, oname, cid, cname, source, conf, merged_at, undone_at in rows:
        conf_s = "-" if conf is None else f"{conf:.2f}"
        state = "undone" if undone_at else "active"
        print(
            f"{mid:>6}  {source:<6}  {conf_s:>4}  {merged_at:%Y-%m-%d %H:%M}  {state:<6}  "
            f"{oname} (#{oid}) -> {cname} (#{cid})",
            file=out,
        )
    return len(rows)


def cmd_undo(conn: psycopg.Connection, merge_id: int, out: TextIO) -> bool:
    try:
        apply.undo(conn, merge_id)
    except apply.MergeError as e:
        conn.rollback()
        print(f"Not undone: {e}", file=out)
        return False
    conn.commit()
    print(
        f"Merge {merge_id} undone. The pair is recorded as different, so it will not be "
        "merged again automatically.",
        file=out,
    )
    return True


# ---------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m pipeline.resolve", description="Entity resolution.")
    sub = p.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="one resolver pass")
    run.add_argument("--limit", type=int, default=50, help="max candidate pairs for the agent")
    run.add_argument(
        "--dry-run",
        action="store_true",
        help="run the agent (spends tokens) but write no merges, pending rows or non-matches",
    )

    review = sub.add_parser("review", help="review pending merges")
    how = review.add_mutually_exclusive_group()
    how.add_argument("--list", action="store_true", help="print pending merges and exit")
    how.add_argument("--accept", type=int, metavar="ID", help="accept one pending merge")
    how.add_argument("--reject", type=int, metavar="ID", help="reject one pending merge")
    review.add_argument(
        "--canonical",
        type=int,
        metavar="ORG_ID",
        help="with --accept: the organization that survives (default: the agent's proposal)",
    )

    merges = sub.add_parser("merges", help="list recent merges")
    merges.add_argument("--limit", type=int, default=20)

    undo = sub.add_parser("undo", help="reverse one merge")
    undo.add_argument("merge_id", type=int, metavar="MERGE_ID")
    return p


def _stdin_reader(stdin: TextIO, out: TextIO) -> Reader:
    def read(prompt: str) -> str:
        out.write(prompt)
        out.flush()
        line = stdin.readline()
        if not line:
            raise EOFError
        return line

    return read


def dispatch(
    args: argparse.Namespace,
    conn: psycopg.Connection,
    *,
    stdin: TextIO,
    out: TextIO,
    err: TextIO,
    provider: Provider | None = None,
    http: PoliteClient | None = None,
) -> int:
    if args.command == "run":
        return cmd_run(
            conn, limit=args.limit, dry_run=args.dry_run, err=err, provider=provider, http=http
        )
    if args.command == "review":
        if args.canonical is not None and args.accept is None:
            print("--canonical only applies with --accept ID", file=err)
            return EXIT_REFUSED
        if args.list:
            print_pending(conn, out)
            return 0
        if args.accept is not None:
            ok = review_one(conn, args.accept, "accepted", args.canonical, out)
            return 0 if ok else EXIT_REFUSED
        if args.reject is not None:
            return 0 if review_one(conn, args.reject, "rejected", None, out) else EXIT_REFUSED
        review_interactive(conn, read=_stdin_reader(stdin, out), out=out)
        return 0
    if args.command == "merges":
        print_merges(conn, out, args.limit)
        return 0
    if args.command == "undo":
        return 0 if cmd_undo(conn, args.merge_id, out) else EXIT_REFUSED
    raise AssertionError(f"unhandled command {args.command}")


def main(
    argv: list[str] | None = None,
    *,
    conn: psycopg.Connection | None = None,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    provider: Provider | None = None,
    http: PoliteClient | None = None,
) -> int:
    """Entry point. `conn`, the streams, `provider` and `http` are injectable for tests."""
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    io = {
        "stdin": stdin or sys.stdin,
        "out": stdout or sys.stdout,
        "err": stderr or sys.stderr,
    }
    if conn is not None:
        return dispatch(args, conn, provider=provider, http=http, **io)
    with connect() as c:
        return dispatch(args, c, provider=provider, http=http, **io)


if __name__ == "__main__":
    sys.exit(main())
