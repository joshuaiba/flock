"""Render a GitHub Actions job summary from the run's stats file.

    FLOCK_STATS_FILE=stats.jsonl python -m pipeline.report >> "$GITHUB_STEP_SUMMARY"

Step outcomes come from env vars OUTCOME_<STEP> (success/failure/skipped).

With DATABASE_URL set it also prints tokens and estimated dollars per agent
(pipeline.agents.costs): month to date, and for this run when
FLOCK_RUN_STARTED_AT holds the time the run began (ISO 8601, set by the
workflow's first step).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

STEPS = ["usaspending", "dod_contracts", "classifier", "resolve"]
TABLES = ["awards", "organizations", "edges", "classifications", "taggings"]
MAX_FAILURES = 10
_USAGE_KEYS = ("input_tokens", "output_tokens", "cost_usd")
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


def run_started() -> datetime | None:
    """FLOCK_RUN_STARTED_AT as an aware datetime, or None if unset or unreadable."""
    raw = os.environ.get("FLOCK_RUN_STARTED_AT", "").strip()
    try:
        started = datetime.fromisoformat(raw) if raw else None
    except ValueError:
        print(f"(ignoring FLOCK_RUN_STARTED_AT={raw!r}: not ISO 8601)", file=sys.stderr)
        return None
    if started is not None and started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    return started


def llm_usage() -> dict | None:
    """Per-agent usage and estimated cost: {run, month, month_start, budget_usd}.

    `run` is None when the run's start time is unknown.
    """
    if not os.environ.get("DATABASE_URL"):
        return None
    try:
        from pipeline.agents import costs
        from pipeline.agents.settings import get_settings
        from pipeline.db import connect

        start = costs.month_start()
        started = run_started()
        with connect() as conn:
            return {
                "run": costs.usage_by_agent(conn, started) if started else None,
                "month": costs.usage_by_agent(conn, start),
                "month_start": start.date().isoformat(),
                "budget_usd": get_settings().monthly_llm_budget_usd,
            }
    except Exception as e:  # summary must never fail the job
        print(f"(could not read LLM usage: {e})", file=sys.stderr)
        return None


def usd(value: float) -> str:
    """Dollars, with enough digits to show the fractions of a cent a run costs."""
    return f"${value:,.2f}" if value >= 1 else f"${value:.4f}"


def render_usage(u: dict) -> list[str]:
    """LLM usage section: tokens and estimated dollars per agent."""
    month = {a["agent"]: a for a in u.get("month") or []}
    run = None if u.get("run") is None else {a["agent"]: a for a in u["run"]}

    def cells(a: dict | None) -> list[str]:
        if a is None:
            return ["–", "–", "–"]
        return [f"{a['input_tokens']:,}", f"{a['output_tokens']:,}", usd(a["cost_usd"])]

    def total(agents: dict | None) -> dict | None:
        if agents is None:
            return None
        return {
            key: sum(a[key] for a in agents.values())
            for key in ("input_tokens", "output_tokens", "cost_usd")
        }

    lines = [
        "",
        "### LLM usage and estimated cost",
        "",
        "| Agent | This run: tokens in | out | est. cost | Month to date: tokens in | out "
        "| est. cost |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for agent in sorted(set(month) | set(run or {})):
        this_run = None if run is None else run.get(agent, dict.fromkeys(_USAGE_KEYS, 0))
        row = [agent, *cells(this_run), *cells(month.get(agent, dict.fromkeys(_USAGE_KEYS, 0)))]
        lines.append("| " + " | ".join(row) + " |")
    lines.append("| **Total** | " + " | ".join([*cells(total(run)), *cells(total(month))]) + " |")

    spent, budget = total(month)["cost_usd"], float(u.get("budget_usd") or 0)
    share = f", {spent / budget:.0%}" if budget else ""
    lines += [
        "",
        f"- Month to date (UTC, since {u.get('month_start', '?')}): **{usd(spent)}** of the "
        f"{usd(budget)} budget (`MONTHLY_LLM_BUDGET_USD`){share}",
    ]
    if spent >= budget:
        lines.append(
            "- **Budget reached.** LLM passes are skipped until the month ends or the "
            "budget is raised."
        )
    if run is None:
        lines.append("- This run's figures need `FLOCK_RUN_STARTED_AT` (the workflow sets it).")
    unpriced = sorted({m for a in [*month.values(), *(run or {}).values()] for m in a["unpriced"]})
    if unpriced:
        lines.append(
            "- No price in `config/pricing.yaml` for "
            + ", ".join(f"`{m}`" for m in unpriced)
            + ": counted as $0."
        )
    lines.append(
        "- Estimated from `agent_runs` at the list prices in `config/pricing.yaml`; "
        "cached input is priced as ordinary input, so this runs a little high."
    )
    return lines


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
    if r.get("over_budget"):
        lines.append(f"- ⏭️ Agent not run: {r['over_budget']}")
    if r.get("stopped"):
        lines.append(
            f"- 🛑 Stopped early: {r['stopped']}; the remaining pairs wait for the next run"
        )
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


def _llm_notes(step: dict, stopped: bool) -> str:
    """What cut an LLM pass short, as a suffix for its detail line."""
    notes = ""
    if step.get("over_budget"):
        notes += f"; ⏭️ skipped: {step['over_budget']}"
    if stopped:
        reason = step.get("stopped")
        notes += f"; 🛑 stopped early{f': {reason}' if isinstance(reason, str) else ''}"
    return notes


def render(
    stats: dict[str, dict],
    outcomes: dict[str, str],
    totals: dict | None,
    usage: dict | None = None,
) -> str:
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
            + _llm_notes(d, bool(d.get("extractions.stopped")))
        )
    if c := stats.get("classifier"):
        details.append(
            f"- **classifier**: {c.get('candidates', 0)} classified, "
            f"{c.get('positive', 0)} autonomy, {c.get('failed', 0)} failed"
            + _llm_notes(c, bool(c.get("stopped")))
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
    if usage:
        lines += render_usage(usage)
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
    stats = read_stats(os.environ.get("FLOCK_STATS_FILE"))
    print(render(stats, outcomes, table_totals(), llm_usage()))


if __name__ == "__main__":
    main()
