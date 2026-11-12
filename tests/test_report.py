import json

from pipeline import report


def test_render_summary(tmp_path):
    path = tmp_path / "stats.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(x)
            for x in [
                {
                    "step": "usaspending",
                    "records": 592,
                    "fetched": True,
                    "awards.inserted": 40,
                    "awards.updated": 552,
                    "organizations.inserted": 7,
                },
                {
                    "step": "dod_contracts",
                    "articles": 0,
                    "articles.new_in_feed": 1,
                    "articles.blocked": 1,
                },
                {
                    "step": "classifier",
                    "candidates": 47,
                    "positive": 30,
                    "failed": 0,
                    "classifications.inserted": 47,
                    "taggings.inserted": 66,
                },
            ]
        )
    )
    md = report.render(
        report.read_stats(str(path)),
        {"usaspending": "success", "dod_contracts": "failure", "classifier": "success"},
        {"awards": 640},
    )
    assert "| usaspending | ✅ success | 40 | 7 | 0 | 0 | 0 |" in md
    assert "| dod_contracts | ❌ failure | 0 | 0 | 0 | 0 | 0 |" in md
    assert "| classifier | ✅ success | 0 | 0 | 0 | 47 | 66 |" in md
    assert "**1 blocked**" in md and "47 classified, 30 autonomy" in md
    assert "| 640 |" in md


def test_render_handles_missing_steps():
    md = report.render({}, {"usaspending": "failure"}, None)
    assert "| usaspending | ❌ failure | – |" in md and "Totals" not in md


RESOLVE = {
    "dry_run": False,
    "auto_merged": 2,
    "candidates": 6,
    "runs": 6,
    "merged": 1,
    "non_matches": 2,
    "pending": 2,
    "failed": 1,
    "skipped": 0,
    "failures": [
        {
            "input_ref": "org:3:9",
            "run_id": 41,
            "error": "UsageLimitExceeded: tool call limit of 8\nhttps://api.sam.gov/x?api_key=SECRET123",
        }
    ],
    "requests": 19,
    "input_tokens": 40000,
    "output_tokens": 2500,
    "total_tokens": 42500,
    "tool_calls": 14,
    "pending_total": 7,
}


def test_render_resolve_section():
    md = report.render({"resolve": RESOLVE}, {"resolve": "success"}, None)
    assert "| resolve | ✅ success | 0 | 0 | 0 | 0 | 0 |" in md
    assert "### Organization resolution\n" in md
    assert "| 6 | 3 | 2 | 2 | 1 | 42500 | 14 |" in md  # runs, merges (1 agent + 2 UEI), ...
    assert "1 by the agent, 2 by exact UEI match" in md
    assert "**7 open in total**" in md
    assert "40000 in + 2500 out over 19 model requests" in md
    assert "- `org:3:9` (agent_runs.id 41): UsageLimitExceeded: tool call limit of 8" in md
    assert "SECRET123" not in md  # API keys in error URLs are redacted


def test_render_resolve_dry_run_and_no_failures():
    r = {**RESOLVE, "dry_run": True, "failed": 0, "failures": []}
    md = report.render({"resolve": r}, {"resolve": "success"}, None)
    assert "### Organization resolution (dry run: nothing applied)" in md
    assert "Merges would be applied" in md and "failed runs**" not in md


def test_render_resolve_missing_stats_and_many_failures():
    md = report.render({}, {"resolve": "failure"}, None)
    assert "| resolve | ❌ failure | – |" in md and "Organization resolution" not in md
    many = [{"input_ref": f"org:1:{i}", "run_id": None, "error": "x" * 500} for i in range(12)]
    md = report.render({"resolve": {**RESOLVE, "failures": many}}, {}, None)
    assert "… and 2 more" in md and "x" * 201 not in md


# --- LLM usage, cost and budget ------------------------------------------------


def agent_usage(agent, tokens_in, tokens_out, cost, unpriced=()):
    return {
        "agent": agent,
        "runs": 1,
        "requests": 1,
        "input_tokens": tokens_in,
        "output_tokens": tokens_out,
        "cost_usd": cost,
        "unpriced": list(unpriced),
    }


USAGE = {
    "run": [agent_usage("classifier", 40_000, 6_000, 0.007)],
    "month": [
        agent_usage("classifier", 1_200_000, 180_000, 0.21),
        agent_usage("resolver", 3_100_000, 260_000, 0.44, unpriced=["fake:test"]),
    ],
    "month_start": "2026-11-01",
    "budget_usd": 90.0,
}


def test_render_usage_per_agent_for_the_run_and_the_month():
    md = report.render({}, {}, None, USAGE)
    assert "### LLM usage and estimated cost" in md
    assert "| classifier | 40,000 | 6,000 | $0.0070 | 1,200,000 | 180,000 | $0.2100 |" in md
    # No resolver runs tonight, but it has spend this month.
    assert "| resolver | 0 | 0 | $0.0000 | 3,100,000 | 260,000 | $0.4400 |" in md
    assert "| **Total** | 40,000 | 6,000 | $0.0070 | 4,300,000 | 440,000 | $0.6500 |" in md
    assert (
        "since 2026-11-01): **$0.6500** of the $90.00 budget (`MONTHLY_LLM_BUDGET_USD`), 1%" in md
    )
    assert "No price in `config/pricing.yaml` for `fake:test`: counted as $0." in md
    assert "Budget reached" not in md


def test_render_usage_without_a_run_start_and_over_budget():
    md = report.render({}, {}, None, {**USAGE, "run": None, "budget_usd": 0.5})
    assert "| classifier | – | – | – | 1,200,000 | 180,000 | $0.2100 |" in md
    assert "**Budget reached.**" in md and "FLOCK_RUN_STARTED_AT" in md
    assert "LLM usage" not in report.render({}, {}, None)  # no database: no section


def test_render_reports_budget_skips_and_early_stops():
    reason = "monthly LLM budget reached: an estimated $90.12 spent since 2026-11-01 UTC"
    stats = {
        "classifier": {"candidates": 0, "positive": 0, "failed": 0, "over_budget": reason},
        "dod_contracts": {
            "articles": 2,
            "extractions.new": 3,
            "extractions.failed": 1,
            "extractions.stopped": 1,
            "stopped": "model credit balance too low",
        },
        "resolve": {**RESOLVE, "candidates": 0, "over_budget": reason},
    }
    outcomes = {"classifier": "success", "dod_contracts": "success", "resolve": "success"}
    md = report.render(stats, outcomes, None)
    assert "| classifier | ✅ success |" in md  # a skip is not a failure
    assert f"0 failed; ⏭️ skipped: {reason}" in md
    assert "1 failed; 🛑 stopped early: model credit balance too low" in md
    assert f"- ⏭️ Agent not run: {reason}" in md
    stopped = report.render({"resolve": {**RESOLVE, "stopped": "model billing error"}}, {}, None)
    assert "🛑 Stopped early: model billing error" in stopped


def test_run_started_reads_the_workflow_timestamp(monkeypatch):
    from datetime import UTC, datetime

    monkeypatch.delenv("FLOCK_RUN_STARTED_AT", raising=False)
    assert report.run_started() is None
    monkeypatch.setenv("FLOCK_RUN_STARTED_AT", "2026-11-11T09:00:03Z")
    assert report.run_started() == datetime(2026, 11, 11, 9, 0, 3, tzinfo=UTC)
    monkeypatch.setenv("FLOCK_RUN_STARTED_AT", "yesterday")
    assert report.run_started() is None  # a bad value must not break the summary
