"""Render a GitHub Actions job summary from the run's stats file.

    FLOCK_STATS_FILE=stats.jsonl python -m pipeline.report >> "$GITHUB_STEP_SUMMARY"

Step outcomes come from env vars OUTCOME_<STEP> (success/failure/skipped).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

STEPS = ["usaspending", "dod_contracts", "classifier", "resolve"]
TABLES = ["awards", "organizations", "edges", "classifications", "taggings"]
MAX_FAILURES = 10
ERROR_CHARS = 200
ICON = {"success": "✅", "failure": "❌", "skipped": "⏭️", "cancelled": "🚫"}


def read_stats(path: str | None) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if path and Path(path).exists():
        for line in Path(path).read_text().splitlines():
            if line.strip():
                rec = json.loads(line)
                out[rec.pop("step")] = rec
    return out


def table_totals() -> dict[str, int] | None:
    if not os.environ.get("DATABASE_URL"):
        return None
    try:
        from pipeline.db import connect

        with connect() as conn:
            return {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in TABLES}
    except Exception as e:  # summary must never fail the job
        print(f"(could not read totals: {e})", file=sys.stderr)
        return None


def _redact(text: str) -> str:
    try:
        from pipeline.agents.run_log import redact

        return redact(text)
    except Exception:  # summary must never fail the job
        return "(error text withheld: redaction unavailable)"


def render_resolve(r: dict) -> list[str]:
    """Organization-resolution section: what the agent did and what it cost."""
    dry = bool(r.get("dry_run"))
    would = "would be " if dry else ""
    agent_merged, auto = r.get("merged", 0), r.get("auto_merged", 0)
    lines = [
        "",
        "### Organization resolution" + (" (dry run: nothing applied)" if dry else ""),
        "",
        "| Agent runs | Merges "
        + ("(would be) " if dry else "applied ")
        + "| Pending review | Non-matches | Failed runs | Tokens | Tool calls |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {r.get('runs', 0)} | {agent_merged + auto} | {r.get('pending', 0)} "
        f"| {r.get('non_matches', 0)} | {r.get('failed', 0)} | {r.get('total_tokens', 0)} "
        f"| {r.get('tool_calls', 0)} |",
        "",
        f"- {r.get('candidates', 0)} candidate pairs sent to the agent"
        + (f", {r['skipped']} skipped as stale" if r.get("skipped") else ""),
        f"- Merges {would}applied: {agent_merged} by the agent, {auto} by exact UEI match",
        f"- Pending review: {r.get('pending', 0)} {would}added this run, "
        f"**{r.get('pending_total', 0)} open in total** "
        "(`uv run python -m pipeline.resolve review`)",
        f"- Tokens: {r.get('input_tokens', 0)} in + {r.get('output_tokens', 0)} out "
        f"over {r.get('requests', 0)} model requests",
    ]
    failures = r.get("failures") or []
    if failures:
        lines += ["", f"**{len(failures)} failed runs** (nothing was applied for these):", ""]
        for f in failures[:MAX_FAILURES]:
            error = " ".join(_redact(str(f.get("error") or "")).split())[:ERROR_CHARS]
            run = f" (agent_runs.id {f['run_id']})" if f.get("run_id") else ""
            lines.append(f"- `{f.get('input_ref', '?')}`{run}: {error}")
        if len(failures) > MAX_FAILURES:
            lines.append(f"- … and {len(failures) - MAX_FAILURES} more (see `agent_runs`)")
    return lines


def render(stats: dict[str, dict], outcomes: dict[str, str], totals: dict | None) -> str:
    lines = [
        "## flock nightly",
        "",
        "### New rows",
        "",
        "| Step | Status | " + " | ".join(TABLES) + " |",
        "| --- | --- | " + " | ".join("---:" for _ in TABLES) + " |",
    ]
    for step in STEPS:
        s = stats.get(step, {})
        outcome = outcomes.get(step, "unknown")
        cells = [str(s.get(f"{t}.inserted", 0)) if s else "–" for t in TABLES]
        lines.append(
            f"| {step} | {ICON.get(outcome, '❔')} {outcome} | " + " | ".join(cells) + " |"
        )

    details = []
    if u := stats.get("usaspending"):
        details.append(
            f"- **usaspending**: {u.get('records', 0)} records in window"
            f"{'' if u.get('fetched', True) else ' (reused same-day snapshot)'}"
        )
    if d := stats.get("dod_contracts"):
        details.append(
            f"- **dod_contracts**: {d.get('articles.new_in_feed', 0)} new in feed, "
            f"{d.get('articles', 0)} fetched (inbox {d.get('articles.inbox', 0)}, "
            f"direct {d.get('articles.via_direct', 0)}, brightdata "
            f"{d.get('articles.via_brightdata', 0)}), **{d.get('articles.blocked', 0)} blocked**; "
            f"{d.get('paragraphs', 0)} paragraphs, {d.get('extractions.new', 0)} extracted, "
            f"{d.get('extractions.cached', 0)} cached, {d.get('extractions.failed', 0)} failed"
        )
    if c := stats.get("classifier"):
        details.append(
            f"- **classifier**: {c.get('candidates', 0)} classified, "
            f"{c.get('positive', 0)} autonomy, {c.get('failed', 0)} failed"
        )
    signals_outcome = outcomes.get("signals")
    if g := stats.get("signals"):
        details.append(
            f"- **signals**: refreshed as of {g.get('as_of', '?')} over "
            f"{g.get('signal_awards', 0)} awards and "
            f"{g.get('signal_opportunities', 0)} solicitations"
        )
    elif signals_outcome and signals_outcome != "success":
        details.append(
            f"- **signals**: {ICON.get(signals_outcome, '❔')} {signals_outcome}; "
            "the dashboard still shows the previous refresh"
        )
    if details:
        lines += ["", "### Details", "", *details]
    if r := stats.get("resolve"):
        lines += render_resolve(r)
    if totals:
        lines += [
            "",
            "### Totals",
            "",
            "| " + " | ".join(totals) + " |",
            "| " + " | ".join("---:" for _ in totals) + " |",
            "| " + " | ".join(str(v) for v in totals.values()) + " |",
        ]
    return "\n".join(lines) + "\n"


def main() -> None:
    outcomes = {s: os.environ.get(f"OUTCOME_{s.upper()}", "unknown") for s in STEPS}
    # Not a loading step (it adds no rows), so it has a detail line, not a table row.
    if signals := os.environ.get("OUTCOME_SIGNALS"):
        outcomes["signals"] = signals
    print(render(read_stats(os.environ.get("FLOCK_STATS_FILE")), outcomes, table_totals()))


if __name__ == "__main__":
    main()
