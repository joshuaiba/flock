"""Resolver agent + runner, with scripted models. No live LLM or network."""

import json

import psycopg
import pytest
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

from pipeline.agents import settings as agent_settings
from pipeline.extract.llm import Provider
from pipeline.http import PoliteClient
from pipeline.resolve import agent, apply, candidates, runner
from pipeline.resolve.deps import ResolveDeps
from pipeline.resolve.models import CandidatePair, MergeDecision
from tests.resolve_helpers import award, count, dump, org
from tests.test_resolve_tools import upstream

pytestmark = pytest.mark.db

TOOL_NAMES = [
    "lookup_sam_entity",
    "search_usaspending_recipient",
    "get_org_awards",
    "compare_addresses",
]


def provider(model) -> Provider:
    return Provider(name="fake:resolver", model=model, min_interval=0.0, sleep=lambda s: None)


def http_client(seen=None) -> PoliteClient:
    seen = [] if seen is None else seen
    return PoliteClient(
        transport=upstream(seen), sleep=lambda s: None, min_interval=0, max_retries=0
    )


def scripted(steps, log=None):
    """A FunctionModel that plays `steps` in order, one per model request.

    Each step is a list of (tool_name, args) calls, or a dict: the final
    MergeDecision, sent through the output tool. A callable step receives the
    messages so far and returns either of those.
    """
    it = iter(steps)

    def respond(messages, info):
        step = next(it)
        if callable(step):
            step = step(messages)
        if log is not None:
            log.append((messages, info))
        if isinstance(step, dict):
            return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, step)])
        return ModelResponse(parts=[ToolCallPart(name, args) for name, args in step])

    return FunctionModel(respond)


def tool_returns(messages) -> dict:
    out = {}
    for m in messages:
        for part in m.parts:
            if isinstance(part, ToolReturnPart):
                out.setdefault(part.tool_name, []).append(part.content)
    return out


def final(decision, confidence, canonical=None, evidence=(), reasoning="r") -> dict:
    return {
        "decision": decision,
        "canonical_org_id": canonical,
        "confidence": confidence,
        "evidence": [
            {"source": src, "url": url, "snippet": snippet, "supports": supports}
            for src, url, snippet, supports in evidence
        ],
        "reasoning": reasoning,
    }


def runs(db):
    return db.execute(
        "SELECT status, requests, jsonb_array_length(tool_calls), error, input_ref, model,"
        " input_tokens, output_tokens, output FROM agent_runs ORDER BY id"
    ).fetchall()


# --- wiring ---------------------------------------------------------------------


def test_agent_wiring_with_testmodel(db):
    a, b = org(db, "Acme Corp"), org(db, "Acme Inc")
    pair = CandidatePair(
        left_org_id=a, right_org_id=b, left_name="Acme Corp", right_name="Acme Inc"
    )
    model = TestModel(
        call_tools=["compare_addresses"],
        custom_output_args=final("unsure", 0.4),
    )
    deps = ResolveDeps(conn=db, http=http_client())
    outcome = agent.decide(pair, deps, provider=provider(model))
    assert isinstance(outcome.decision, MergeDecision) and outcome.error is None
    assert outcome.decision.decision == "unsure"

    params = model.last_model_request_parameters
    assert [t.name for t in params.function_tools] == TOOL_NAMES
    assert [t.name for t in params.output_tools] == ["final_result"]  # tool output mode
    assert all(t.description for t in params.function_tools)
    # sequential tools: the three that share the connection / HTTP client
    assert [t.name for t in params.function_tools if t.sequential] == TOOL_NAMES[:3]

    (row,) = runs(db)
    assert row[0] == "ok" and row[2] == 1 and row[4] == f"org:{a}:{b}" and row[5] == "fake:resolver"
    assert outcome.run_id == db.execute("SELECT id FROM agent_runs").fetchone()[0]


def test_prompt_and_instructions_carry_pair_budget_and_no_model_name(db, monkeypatch):
    monkeypatch.setenv("RESOLVE_TOOL_CALLS_LIMIT", "5")
    agent_settings.reset_settings()
    a, b = org(db, "Acme Corp", uei="AAAAAAAAAAAA"), org(db, "Acme Inc")
    pair = CandidatePair(
        left_org_id=a,
        right_org_id=b,
        left_name="Acme Corp",
        right_name="Acme Inc",
        left_uei="AAAAAAAAAAAA",
        signals={"name_similarity": 1.0},
    )
    log = []
    model = scripted([final("unsure", 0.3)], log)
    agent.decide(pair, ResolveDeps(conn=db, http=http_client()), provider=provider(model))
    messages, info = log[0]
    prompt = messages[0].parts[-1].content
    body = json.loads(prompt.split("<pair>\n", 1)[1].rsplit("\n</pair>", 1)[0])
    assert body["left"] == {"org_id": a, "name": "Acme Corp", "uei": "AAAAAAAAAAAA"}
    assert body["right"]["org_id"] == b and body["signals"] == {"name_similarity": 1.0}
    assert "at most 5 tool calls" in info.instructions
    assert "joint venture" in info.instructions.lower() and "subsidiary" in info.instructions
    assert "gemini" not in info.instructions.lower()


# --- scripted decisions, end to end through the runner -----------------------------


def _division_orgs(db):
    lm = org(db, "Lockheed Martin Corp.", uei="ZFN2JJXBLZT3", source="usaspending")
    mfc = org(db, "Lockheed Martin Corp., Missiles and Fire Control", source="dod_contracts")
    award(db, "1", recipient=lm)
    award(db, "2", recipient=mfc)
    db.commit()
    return lm, mfc


def _merge_script(lm, mfc, confidence=0.95):
    return [
        [("get_org_awards", {"org_id": lm}), ("get_org_awards", {"org_id": mfc})],
        final(
            "merge",
            confidence,
            canonical=lm,
            evidence=[
                ("names", None, "second name is the first plus a division", "merge"),
                ("db", None, "both rows hold Lockheed Martin awards", "merge"),
            ],
            reasoning="A division written after the company name is the same legal entity.",
        ),
    ]


def test_division_of_same_entity_is_merged(db):
    lm, mfc = _division_orgs(db)
    stats = runner.run(
        db, limit=10, provider=provider(scripted(_merge_script(lm, mfc))), http=http_client()
    )
    assert stats["candidates"] == 1 and stats["merged"] == 1 and stats["failed"] == 0
    assert stats["pending"] == stats["non_matches"] == stats["auto_merged"] == 0
    assert stats["runs"] == 1 and stats["requests"] == 2 and stats["tool_calls"] == 2
    assert stats["total_tokens"] == stats["input_tokens"] + stats["output_tokens"] > 0
    assert json.loads(json.dumps(stats)) == stats  # goes into the job summary

    (run,) = runs(db)
    assert run[0] == "ok" and run[8]["decision"] == "merge"
    run_id = db.execute("SELECT id FROM agent_runs").fetchone()[0]
    assert db.execute(
        "SELECT canonical_org_id, merged_org_id, decision_source, agent_run_id FROM org_merges"
    ).fetchall() == [(lm, mfc, "agent", run_id)]
    assert (
        db.execute("SELECT merged_into FROM organizations WHERE id = %s", (mfc,)).fetchone()[0]
        == lm
    )
    assert count(db, "awards", "recipient_id = %s", (lm,)) == 2

    # Everything was committed: a second connection sees it.
    dsn = psycopg.conninfo.make_conninfo(db.info.dsn, password=db.info.password)
    with psycopg.connect(dsn) as other:
        assert count(other, "org_merges") == 1 and count(other, "agent_runs") == 1

    # Nothing left to ask, and no model is needed (or built) when there are no pairs.
    again = runner.run(db, limit=10, http=http_client())
    assert again["candidates"] == 0 and again["runs"] == 0


def test_similar_names_different_companies_are_separate(db):
    """Sikorsky vs the Boeing Sikorsky joint venture, on the recorded USAspending data."""
    sik = org(db, "SIKORSKY AIRCRAFT CORPORATION", uei="UTJWTSLMFNG4")
    jv = org(db, "BOEING SIKORSKY AIRCRAFT SUPPORT, LLC", uei="H91LD1GY6JN5")
    pair = CandidatePair(
        left_org_id=sik,
        right_org_id=jv,
        left_name="SIKORSKY AIRCRAFT CORPORATION",
        right_name="BOEING SIKORSKY AIRCRAFT SUPPORT, LLC",
        left_uei="UTJWTSLMFNG4",
        right_uei="H91LD1GY6JN5",
        signals={"different_ueis": True},
    )

    def decide_from_search(messages):
        (search,) = tool_returns(messages)["search_usaspending_recipient"]
        by_uei = {r.uei: r for r in search.recipients}
        s, j = by_uei["UTJWTSLMFNG4"], by_uei["H91LD1GY6JN5"]
        assert s.name == pair.left_name and j.name == pair.right_name
        assert s.parent_uei != j.parent_uei
        return final(
            "separate",
            0.96,
            evidence=[
                ("usaspending", s.url, f"{s.name} UEI {s.uei}, parent {s.parent_name}", "separate"),
                ("usaspending", j.url, f"{j.name} UEI {j.uei}, parent {j.parent_name}", "separate"),
            ],
            reasoning="Different UEIs; the second is a Boeing/Sikorsky joint venture.",
        )

    seen = []
    model = scripted(
        [[("search_usaspending_recipient", {"name": "SIKORSKY AIRCRAFT"})], decide_from_search]
    )
    deps = ResolveDeps(conn=db, http=http_client(seen))
    outcome = agent.decide(pair, deps, provider=provider(model))
    assert outcome.error is None and outcome.decision.decision == "separate"
    assert {r.url.host for r in seen} == {"api.usaspending.gov"}
    assert all(
        e.url.startswith("https://www.usaspending.gov/recipient/")
        for e in outcome.decision.evidence
    )

    action = apply.apply_decision(db, pair, outcome.decision, agent_run_id=outcome.run_id)
    assert action == "non_match"
    assert db.execute(
        "SELECT left_org_id, right_org_id, agent_run_id FROM org_non_matches"
    ).fetchall() == [(sik, jv, outcome.run_id)]
    assert count(db, "org_merges") == count(db, "pending_merges") == 0
    # Even with the threshold dropped to zero the pair is never proposed again.
    assert (sik, jv) in candidates._excluded_pairs(db)


def test_recorded_non_match_is_not_reproposed_by_the_runner(db):
    a = org(db, "Sikorsky Aircraft Corp", uei="UTJWTSLMFNG4")
    b = org(db, "Sikorsky Aircraft Corporation", uei="URBRE5WUGB78")
    db.commit()
    script = [
        [("search_usaspending_recipient", {"name": "SIKORSKY AIRCRAFT"})],
        final(
            "separate",
            0.92,
            evidence=[("usaspending", None, "two registrations, different UEIs", "separate")],
        ),
    ]
    first = runner.run(db, limit=10, provider=provider(scripted(script)), http=http_client())
    assert first["candidates"] == 1 and first["non_matches"] == 1
    assert db.execute("SELECT left_org_id, right_org_id FROM org_non_matches").fetchall() == [
        (a, b)
    ]
    second = runner.run(db, limit=10, provider=provider(scripted([])), http=http_client())
    assert second["candidates"] == 0 and second["runs"] == 0


def test_conflicting_evidence_goes_to_pending(db):
    lm, mfc = _division_orgs(db)
    script = [
        [("get_org_awards", {"org_id": lm})],
        [
            (
                "compare_addresses",
                {"a": "6900 Main St, Stratford, CT 06614", "b": "1 Elm Rd, Dallas, TX 75001"},
            )
        ],
        final(
            "unsure",
            0.5,
            evidence=[
                ("names", None, "division-style name", "merge"),
                ("address", None, "addresses are in different states", "separate"),
            ],
            reasoning="The name suggests a division but the addresses conflict.",
        ),
    ]
    stats = runner.run(db, limit=10, provider=provider(scripted(script)), http=http_client())
    assert stats["pending"] == 1 and stats["merged"] == 0 and stats["pending_total"] == 1
    row = db.execute(
        "SELECT left_org_id, right_org_id, decision, canonical_org_id, confidence,"
        " jsonb_array_length(evidence), reviewed_at, agent_run_id IS NOT NULL FROM pending_merges"
    ).fetchone()
    assert row == (lm, mfc, "unsure", None, 0.5, 2, None, True)
    assert count(db, "org_merges") == 0
    # An open question is not asked again the next night.
    nxt = runner.run(db, limit=10, provider=provider(scripted([])), http=http_client())
    assert nxt["candidates"] == 0 and nxt["pending_total"] == 1


def test_low_confidence_merge_goes_to_pending_not_merged(db):
    lm, mfc = _division_orgs(db)
    stats = runner.run(
        db, limit=10, provider=provider(scripted(_merge_script(lm, mfc, 0.8))), http=http_client()
    )
    assert stats["pending"] == 1 and stats["merged"] == 0
    assert db.execute("SELECT decision, canonical_org_id FROM pending_merges").fetchone() == (
        "merge",
        lm,
    )


# --- budgets ------------------------------------------------------------------------


def _assert_failed_run_changed_nothing(db, stats, before, error_match):
    assert stats["failed"] == 1 and stats["merged"] == stats["pending"] == 0
    assert stats["non_matches"] == 0
    (failure,) = stats["failures"]
    assert error_match in failure["error"] and failure["run_id"] is not None
    (run,) = runs(db)
    assert run[0] == "failed" and error_match in run[3] and run[8] is None
    assert count(db, "org_merges") + count(db, "pending_merges") + count(db, "org_non_matches") == 0
    assert dump(db) == before
    return run


def test_tool_call_budget_exceeded_fails_the_run_and_merges_nothing(db, monkeypatch):
    monkeypatch.setenv("RESOLVE_TOOL_CALLS_LIMIT", "2")
    agent_settings.reset_settings()
    lm, mfc = _division_orgs(db)
    before = dump(db)
    lookup = [("get_org_awards", {"org_id": lm})]
    script = [lookup, lookup, lookup, *_merge_script(lm, mfc)[1:]]  # third call is over budget
    stats = runner.run(db, limit=10, provider=provider(scripted(script)), http=http_client())
    run = _assert_failed_run_changed_nothing(db, stats, before, "UsageLimitExceeded")
    assert "tool_calls_limit" in run[3]
    assert run[1] == 3 and stats["tool_calls"] == 3  # the refused call is still on the audit row
    assert stats["runs"] == 1


def test_token_budget_exceeded_fails_the_run_and_merges_nothing(db, monkeypatch):
    monkeypatch.setenv("RESOLVE_TOTAL_TOKENS_LIMIT", "60")
    agent_settings.reset_settings()
    lm, mfc = _division_orgs(db)
    before = dump(db)
    stats = runner.run(
        db, limit=10, provider=provider(scripted(_merge_script(lm, mfc))), http=http_client()
    )
    run = _assert_failed_run_changed_nothing(db, stats, before, "UsageLimitExceeded")
    assert "total_tokens_limit" in run[3] and run[6] + run[7] > 60


def test_request_budget_exceeded(db, monkeypatch):
    monkeypatch.setenv("RESOLVE_REQUEST_LIMIT", "1")
    agent_settings.reset_settings()
    lm, mfc = _division_orgs(db)
    before = dump(db)
    stats = runner.run(
        db, limit=10, provider=provider(scripted(_merge_script(lm, mfc))), http=http_client()
    )
    _assert_failed_run_changed_nothing(db, stats, before, "UsageLimitExceeded")


def test_one_failed_pair_does_not_stop_the_rest(db):
    lm, mfc = _division_orgs(db)
    a, b = org(db, "Anduril Industries, Inc."), org(db, "ANDURIL INDUSTRIES INC")
    db.commit()

    # First pair (Anduril, score 1.0): output is invalid twice -> retries exhausted.
    bad = final("merge", 0.95, canonical=424242)
    script = [bad, bad, *_merge_script(lm, mfc)]
    stats = runner.run(db, limit=10, provider=provider(scripted(script)), http=http_client())
    assert stats["candidates"] == 2 and stats["failed"] == 1 and stats["merged"] == 1
    assert stats["failures"][0]["input_ref"] == f"org:{a}:{b}"
    assert "UnexpectedModelBehavior" in stats["failures"][0]["error"]
    assert [r[0] for r in runs(db)] == ["failed", "ok"]


# --- output validator ---------------------------------------------------------------


def test_validator_rejects_canonical_outside_pair_then_accepts_correction(db):
    lm, mfc = _division_orgs(db)
    log = []
    good = _merge_script(lm, mfc)[1]
    model = scripted([{**good, "canonical_org_id": 424242}, good], log)
    pair = candidates.name_pairs(db, limit=1)[0]
    outcome = agent.decide(pair, ResolveDeps(conn=db, http=http_client()), provider=provider(model))
    assert outcome.decision.canonical_org_id == lm
    assert len(log) == 2
    feedback = str(log[1][0][-1].parts)
    assert f"{lm} or {mfc}" in feedback
    assert runs(db)[0][:2] == ("ok", 2)


def test_validator_requires_merge_evidence_for_confident_merge(db):
    lm, mfc = _division_orgs(db)
    pair = candidates.name_pairs(db, limit=1)[0]
    deps = ResolveDeps(conn=db, http=http_client())
    no_support = final(
        "merge", 0.95, canonical=lm, evidence=[("names", None, "different UEIs", "separate")]
    )
    outcome = agent.decide(pair, deps, provider=provider(scripted([no_support, no_support])))
    assert outcome.decision is None and "UnexpectedModelBehavior" in outcome.error
    assert outcome.run_id is not None and runs(db)[0][0] == "failed"

    # Below the auto-merge threshold the same output is allowed (it goes to review).
    low = {**no_support, "confidence": 0.7}
    outcome = agent.decide(pair, deps, provider=provider(scripted([low])))
    assert outcome.decision.confidence == 0.7

    # canonical_org_id on a non-merge is dropped rather than retried.
    sep = final("separate", 0.9, canonical=lm)
    outcome = agent.decide(pair, deps, provider=provider(scripted([sep])))
    assert outcome.decision.canonical_org_id is None


# --- dry run and UEI auto-merge -------------------------------------------------------


def test_dry_run_runs_the_agent_but_writes_no_merge_rows(db):
    lm, mfc = _division_orgs(db)
    u1 = org(db, "Acme One", uei="AAAAAAAAAAAA", source="x")
    org(db, "Acme 1 Holdings", uei="AAAAAAAAAAAA", source="y")
    db.commit()
    before = dump(db)
    stats = runner.run(
        db,
        limit=10,
        dry_run=True,
        provider=provider(scripted(_merge_script(lm, mfc))),
        http=http_client(),
    )
    assert stats["dry_run"] is True
    assert stats["merged"] == 1 and stats["auto_merged"] == 1  # what would have happened
    assert stats["runs"] == 1 and stats["total_tokens"] > 0  # the cost was real and is logged
    assert count(db, "agent_runs") == 1
    assert count(db, "org_merges") + count(db, "pending_merges") + count(db, "org_non_matches") == 0
    assert dump(db) == before and u1 is not None


def test_uei_auto_merge_needs_no_model(db):
    usa = org(
        db, "LEIDOS, INC.", uei="UE9QJD4KK1L6", source="usaspending", source_id="uei:UE9QJD4KK1L6"
    )
    dod = org(db, "Leidos Inc.", uei="UE9QJD4KK1L6", source="dod_contracts")
    third = org(db, "Leidos", uei="UE9QJD4KK1L6", source="z")
    db.commit()
    stats = runner.run(db, limit=10, http=http_client())  # no provider, no GEMINI_API_KEY
    assert stats["auto_merged"] == 2 and stats["candidates"] == 0 and stats["runs"] == 0
    assert db.execute(
        "SELECT canonical_org_id, merged_org_id, decision_source, confidence, agent_run_id"
        " FROM org_merges ORDER BY merged_org_id"
    ).fetchall() == [(usa, dod, "uei", 1.0, None), (usa, third, "uei", 1.0, None)]
    assert runner.run(db, limit=10, http=http_client())["auto_merged"] == 0


def test_stale_pairs_are_skipped_after_a_merge_in_the_same_run(db):
    a = org(db, "Vector Aero Inc")
    b = org(db, "Vector Aero LLC")
    c = org(db, "Vector Aero Corp")
    db.commit()
    ev = [("names", None, "same name", "merge")]
    # Pairs in order: (a,b), (a,c), (b,c). Merge b into a; then a/c is unsure; b/c is stale.
    script = [final("merge", 0.95, canonical=a, evidence=ev), final("unsure", 0.5)]
    stats = runner.run(db, limit=10, provider=provider(scripted(script)), http=http_client())
    assert stats["candidates"] == 3 and stats["merged"] == 1 and stats["pending"] == 1
    assert stats["skipped"] == 1 and stats["runs"] == 2 and stats["failed"] == 0
    assert db.execute("SELECT left_org_id, right_org_id FROM pending_merges").fetchall() == [(a, c)]
    assert count(db, "organizations", "id = %s AND merged_into = %s", (b, a)) == 1
