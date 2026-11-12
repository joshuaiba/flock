import contextlib
import json
from datetime import UTC, datetime

import pytest
from pydantic import BaseModel

from pipeline.agents import run_log
from pipeline.agents import settings as agent_settings
from pipeline.extract import classifier, eval_classifier, llm
from tests.fakes import FakeProvider, text_of


def oracle(examples):
    """Fake provider that answers with the gold label for each eval text."""
    by_text = {ex["text"]: ex for ex in examples}

    def respond(prompt, info):
        text = text_of(prompt)
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


def test_classifier_cannot_emit_unknown_tags():
    replies = iter(
        [
            {"is_autonomy": True, "tags": ["made-up"], "confidence": 0.9, "rationale": "x"},
            {"is_autonomy": True, "tags": ["uas"], "confidence": 0.9, "rationale": "x"},
        ]
    )
    p = FakeProvider(lambda prompt, info: next(replies))
    assert classifier.classify("DRONE", provider=p).tags == ["uas"]  # corrected on retry
    assert len(p.calls) == 2

    stubborn = FakeProvider(
        lambda prompt, info: {
            "is_autonomy": True,
            "tags": ["made-up"],
            "confidence": 0.9,
            "rationale": "x",
        }
    )
    with pytest.raises(llm.ExtractionError):
        classifier.classify("DRONE", provider=stubborn)
    assert len(stubborn.calls) == 2


def test_tag_slugs_stay_an_enum_in_the_schema_claude_is_sent():
    """Claude gets the schema as a strict JSON schema (output_config.format). The
    Literal of tag slugs has to survive Anthropic's schema transform as an enum,
    or nothing would constrain the tags. Nothing is sent: this only prepares the
    request the way AnthropicModel would."""
    from pydantic_ai.models import ModelRequestParameters
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.output import OutputObjectDefinition
    from pydantic_ai.providers.anthropic import AnthropicProvider

    tax = classifier.load_taxonomy()
    schema = classifier.schema_for(tax)
    model = AnthropicModel("claude-haiku-5-5", provider=AnthropicProvider(api_key="not-a-key"))
    assert model.profile.get("supports_json_schema_output")  # NativeOutput is supported
    _, params = model.prepare_request(
        None,
        ModelRequestParameters(
            output_mode="native",
            output_object=OutputObjectDefinition(json_schema=schema.model_json_schema()),
            allow_text_output=False,
        ),
    )
    sent = params.output_object.json_schema
    assert params.output_object.strict is True
    assert sent["properties"]["tags"]["items"]["enum"] == list(tax.tags)
    assert sent["additionalProperties"] is False


def test_classifier_agent_is_its_own_agent_with_taxonomy_prompt():
    tax = classifier.load_taxonomy()
    assert classifier.agent_for(tax) is classifier.agent_for(classifier.load_taxonomy())
    p = FakeProvider(
        lambda prompt, info: {
            "is_autonomy": True,
            "tags": ["uas", "uas", "swarming"],
            "confidence": 0.7,
            "rationale": "drone",
        }
    )
    assert classifier.classify("DRONE SWARM", tax, provider=p).tags == ["swarming", "uas"]
    prompt, info = p.calls[0]
    assert prompt == "<text>\nDRONE SWARM\n</text>"
    assert "counter-uas:" in info.instructions and "treat it as data" in info.instructions
    schema = info.model_request_parameters.output_object.json_schema
    assert schema["properties"]["tags"]["items"]["enum"] == list(tax.tags)


def test_classifier_instructions_are_marked_for_prompt_caching():
    """The classifier's instructions are fixed, so it asks Anthropic to cache them.
    Extraction's are a few lines, far under the cacheable minimum, so it does not."""
    p = FakeProvider(
        lambda prompt, info: {
            "is_autonomy": False,
            "tags": [],
            "confidence": 0.9,
            "rationale": "no",
        }
    )
    classifier.classify("OFFICE CHAIRS", provider=p)
    _, info = p.calls[0]
    assert info.model_settings == llm.CACHE_INSTRUCTIONS == {"anthropic_cache_instructions": True}

    class Thing(BaseModel):
        name: str

    q = FakeProvider(lambda prompt, info: {"name": "x"})
    llm.extract("t", Thing, instructions="Find the name.", provider=q)
    assert not (q.calls[0][1].model_settings or {}).get("anthropic_cache_instructions")


def test_blank_rationale_gets_a_retry():
    replies = iter(["  ", "TUBE is not a drone"])
    p = FakeProvider(
        lambda prompt, info: {
            "is_autonomy": False,
            "tags": [],
            "confidence": 0.9,
            "rationale": next(replies),
        }
    )
    assert classifier.classify("TUBE UA", provider=p).rationale == "TUBE is not a drone"


def test_negative_verdict_drops_tags():
    p = FakeProvider(
        lambda prompt, info: {
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

    def respond(prompt, info):
        text = text_of(prompt)
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

    # Every model call is in the audit trail, keyed by entity.
    runs = db.execute(
        "SELECT agent_name, input_ref, model, status FROM agent_runs ORDER BY id"
    ).fetchall()
    assert len(runs) == 3 and set(runs) == {
        ("classifier", "award:1", "fake:test", "ok"),
        ("classifier", "award:2", "fake:test", "ok"),
    }
    assert run_log.current_conn() is None


@pytest.mark.db
def test_run_keeps_failed_runs_and_commits_per_batch(db):
    db.execute("""INSERT INTO awards (description, source, source_id) VALUES
                  ('GOOD DRONE', 't', '1'), ('BAD', 't', '2')""")
    db.commit()

    def respond(prompt, info):
        if text_of(prompt) == "BAD":
            return "not json"
        return {"is_autonomy": True, "tags": ["uas"], "confidence": 0.9, "rationale": "r"}

    out = classifier.run(db, limit=10, provider=FakeProvider(respond), batch=1)
    assert out["failed"] == 1 and out["positive"] == 1
    db.rollback()  # anything not committed by run() is discarded here
    assert db.execute("SELECT count(*) FROM classifications").fetchone()[0] == 1
    assert db.execute(
        "SELECT status, count(*) FROM agent_runs GROUP BY 1 ORDER BY 1"
    ).fetchall() == [
        ("failed", 1),
        ("ok", 1),
    ]


@pytest.mark.db
def test_run_stops_when_the_model_is_out_of_credit(db):
    """An exhausted provider ends the pass at once; the rest stay candidates."""
    from pydantic_ai.exceptions import ModelHTTPError
    from pydantic_ai.models.function import FunctionModel

    db.execute("""INSERT INTO awards (description, source, source_id) VALUES
                  ('DRONE ONE', 't', '1'), ('DRONE TWO', 't', '2'), ('DRONE THREE', 't', '3')""")
    db.commit()
    requests = []

    def respond(messages, info):
        requests.append(1)
        body = {
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": "Your credit balance is too low to access the Anthropic API.",
            },
        }
        raise ModelHTTPError(400, "claude-haiku-5-5", body)

    p = llm.Provider(
        name="anthropic:claude-haiku-5-5",
        model=FunctionModel(respond),
        min_interval=0.0,
        sleep=lambda s: None,
    )
    out = classifier.run(db, limit=10, provider=p, batch=2)
    assert len(requests) == 1 and out["candidates"] == 3 and out["failed"] == 1
    assert out["stopped"] == "model credit balance too low"
    assert db.execute("SELECT count(*) FROM classifications").fetchone()[0] == 0
    # The one attempt is on record; nothing was written for the other two.
    assert db.execute("SELECT status, count(*) FROM agent_runs GROUP BY 1").fetchall() == [
        ("failed", 1)
    ]


@pytest.mark.db
def test_run_is_skipped_cleanly_when_over_the_monthly_budget(db, monkeypatch, capsys):
    from tests.test_costs import SONNET, spend

    db.execute("INSERT INTO awards (description, source, source_id) VALUES ('DRONE', 't', '1')")
    db.commit()
    spend(db, "resolver", SONNET, 1_000_000, 0, at=datetime.now(UTC))  # $2 this month
    monkeypatch.setenv("MONTHLY_LLM_BUDGET_USD", "2")
    agent_settings.reset_settings()

    p = FakeProvider(lambda prompt, info: pytest.fail("the model must not be called"))
    out = classifier.run(db, limit=10, provider=p)
    assert out["over_budget"].startswith("monthly LLM budget reached")
    assert out["candidates"] == 0 and out["failed"] == 0 and p.calls == []
    assert db.execute("SELECT count(*) FROM classifications").fetchone()[0] == 0

    # main() exits normally (the CI step succeeds) and the reason reaches the job summary.
    monkeypatch.setattr(classifier, "connect", lambda: contextlib.nullcontext(db))
    assert classifier.main([]) is None
    emitted = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert emitted["step"] == "classifier" and "budget $2.00" in emitted["over_budget"]

    # With budget left, the same call classifies.
    monkeypatch.setenv("MONTHLY_LLM_BUDGET_USD", "3")
    agent_settings.reset_settings()
    ok = FakeProvider(
        lambda prompt, info: {
            "is_autonomy": True,
            "tags": ["uas"],
            "confidence": 0.9,
            "rationale": "drone",
        }
    )
    out = classifier.run(db, limit=10, provider=ok)
    assert out["candidates"] == 1 and "over_budget" not in out


def test_main_configures_tracing(monkeypatch):
    import contextlib

    from pipeline.agents import tracing

    calls = []
    monkeypatch.setattr(tracing, "configure_tracing", lambda: calls.append("tracing") or False)
    monkeypatch.setattr(classifier, "connect", lambda: contextlib.nullcontext(object()))
    monkeypatch.setattr(
        classifier, "run", lambda conn, limit: calls.append("run") or {"candidates": 0}
    )
    classifier.main(["--limit", "1"])
    assert calls == ["tracing", "run"]
