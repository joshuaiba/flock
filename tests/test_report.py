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
