import json

import pytest

from pipeline.extract import classifier, eval_classifier
from tests.fakes import FakeProvider


def oracle(examples):
    """Fake provider that answers with the gold label for each eval text."""
    by_text = {ex["text"]: ex for ex in examples}

    def respond(prompt, schema):
        text = prompt.split("<text>\n", 1)[1].rsplit("\n</text>", 1)[0]
        ex = by_text[text]
        return {
            "is_autonomy": ex["is_autonomy"],
            "tags": ex["tags"],
            "confidence": 0.9,
            "rationale": "gold",
        }

    return FakeProvider(respond)


def test_eval_set_is_valid():
    examples = eval_classifier.load(eval_classifier.DEFAULT_PATH)
    tax = classifier.load_taxonomy()
    assert len(examples) == 20
    assert len({ex["id"] for ex in examples}) == 20
    assert 0 < sum(ex["is_autonomy"] for ex in examples) < 20
    for ex in examples:
        assert set(ex["tags"]) <= set(tax.tags), ex["id"]
        assert bool(ex["tags"]) == ex["is_autonomy"], ex["id"]


def test_schema_constrains_tags_to_taxonomy():
    tax = classifier.load_taxonomy()
    schema = classifier.schema_for(tax).model_json_schema()
    assert schema["properties"]["tags"]["items"]["enum"] == list(tax.tags)
    with pytest.raises(ValueError):
        classifier.schema_for(tax).model_validate(
            {"is_autonomy": True, "tags": ["made-up"], "confidence": 0.5, "rationale": "x"}
        )


def test_negative_verdict_drops_tags():
    p = FakeProvider(
        lambda prompt, schema: {
            "is_autonomy": False,
            "tags": ["uas"],
            "confidence": 0.8,
            "rationale": "x",
        }
    )
    assert classifier.classify("TUBE UA", provider=p).tags == []


def test_perfect_predictions_score_one():
    examples = eval_classifier.load(eval_classifier.DEFAULT_PATH)
    report, _ = eval_classifier.evaluate(examples, provider=oracle(examples))
    assert report["is_autonomy"]["precision"] == report["is_autonomy"]["recall"] == 1.0
    assert report["tags_micro"]["f1"] == 1.0


def test_score_counts_errors():
    gold = [
        {"is_autonomy": True, "tags": ["uas"]},
        {"is_autonomy": True, "tags": ["maritime"]},
        {"is_autonomy": False, "tags": []},
        {"is_autonomy": False, "tags": []},
    ]
    pred = [
        {"is_autonomy": True, "tags": ["uas", "swarming"]},
        {"is_autonomy": False, "tags": []},
        {"is_autonomy": True, "tags": ["uas"]},
        {"is_autonomy": False, "tags": []},
    ]
    r = eval_classifier.score(gold, pred)
    assert r["is_autonomy"] == {
        "precision": 0.5,
        "recall": 0.5,
        "f1": 0.5,
        "tp": 1,
        "fp": 1,
        "fn": 1,
    }
    assert r["per_tag"]["uas"]["fp"] == 1 and r["per_tag"]["maritime"]["fn"] == 1
    assert r["tags_micro"]["tp"] == 1 and r["tags_micro"]["fp"] == 2


@pytest.mark.db
def test_run_writes_verdicts_and_taggings_idempotently(db):
    db.execute("""INSERT INTO awards (description, source, source_id) VALUES
                  ('PROCURE COMPACT TACTICAL DRONE', 't', '1'),
                  ('4571912382!TUBE UA CHRY RD YLW 100MM 16MM VCTNR', 't', '2')""")
    verdicts = {
        "PROCURE COMPACT TACTICAL DRONE": (True, ["uas"]),
        "4571912382!TUBE UA CHRY RD YLW 100MM 16MM VCTNR": (False, []),
    }

    def respond(prompt, schema):
        text = prompt.split("<text>\n", 1)[1].rsplit("\n</text>", 1)[0]
        pos, tags = verdicts[text]
        return {"is_autonomy": pos, "tags": tags, "confidence": 0.9, "rationale": "r"}

    p = FakeProvider(respond)
    out = classifier.run(db, limit=10, provider=p)
    assert out["candidates"] == 2 and out["positive"] == 1
    assert out["classifications.inserted"] == 2 and out["taggings.inserted"] == 2  # autonomy + uas
    tagged = db.execute("""SELECT a.description, t.slug FROM taggings g
                           JOIN tags t ON t.id = g.tag_id JOIN awards a ON a.id = g.entity_id
                           ORDER BY 2""").fetchall()
    assert tagged == [
        ("PROCURE COMPACT TACTICAL DRONE", "autonomy"),
        ("PROCURE COMPACT TACTICAL DRONE", "uas"),
    ]

    # Unchanged text: nothing to do, no LLM calls.
    assert classifier.run(db, limit=10, provider=p)["candidates"] == 0 and len(p.calls) == 2

    # Changed text: re-classified, stale tags removed.
    db.execute("UPDATE awards SET description = 'COUNTER UAS SYSTEMS' WHERE source_id = '1'")
    verdicts["COUNTER UAS SYSTEMS"] = (True, ["counter-uas"])
    out = classifier.run(db, limit=10, provider=p)
    assert out["candidates"] == 1 and out["classifications.updated"] == 1
    slugs = [
        r[0]
        for r in db.execute(
            "SELECT t.slug FROM taggings g JOIN tags t ON t.id = g.tag_id ORDER BY 1"
        )
    ]
    assert slugs == ["autonomy", "counter-uas"]
    assert json.loads(json.dumps(out))  # stats are JSON-serializable for the job summary
