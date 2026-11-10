"""Render a GitHub Actions job summary from the run's stats file.

    FLOCK_STATS_FILE=stats.jsonl python -m pipeline.report >> "$GITHUB_STEP_SUMMARY"

Step outcomes come from env vars OUTCOME_<STEP> (success/failure/skipped).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

STEPS = ["usaspending", "dod_contracts", "classifier"]
TABLES = ["awards", "organizations", "edges", "classifications", "taggings"]
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
    if details:
        lines += ["", "### Details", "", *details]
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
    print(render(read_stats(os.environ.get("FLOCK_STATS_FILE")), outcomes, table_totals()))


if __name__ == "__main__":
    main()
