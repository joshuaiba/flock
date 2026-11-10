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
