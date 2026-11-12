"""Runner robustness: one bad pair or auto-merge must not sink the pass."""

import psycopg
import pytest

from pipeline.resolve import agent, apply, runner
from pipeline.resolve.models import MergeDecision
from tests.resolve_helpers import count, org
from tests.test_resolve_agent import http_client, provider, scripted

pytestmark = pytest.mark.db

UNSURE = MergeDecision(
    decision="unsure", canonical_org_id=None, confidence=0.4, evidence=[], reasoning="thin"
)


def _two_pairs(db):
    a, b = org(db, "Skydio Inc"), org(db, "Skydio, Inc.")
    c, d = org(db, "Anduril Industries"), org(db, "Anduril Industries Inc")
    db.commit()
    return (a, b), (c, d)


def _run(db):
    return runner.run(db, limit=10, provider=provider(scripted([])), http=http_client())


def test_unexpected_exception_in_one_pair_does_not_abort_the_pass(db, monkeypatch):
    first, second = _two_pairs(db)
    seen = []

    def decide(pair, deps, *, provider=None):
        seen.append((pair.left_org_id, pair.right_org_id))
        if len(seen) == 1:
            raise RuntimeError("tool blew up at https://api.sam.gov/x?api_key=sekret-123&q=1")
        return agent.Outcome(decision=UNSURE, run_id=None, error=None)

    monkeypatch.setattr(agent, "decide", decide)
    stats = _run(db)
    assert len(seen) == 2 and set(seen) == {first, second}
    assert stats["failed"] == 1 and stats["pending"] == 1
    (failure,) = stats["failures"]
    assert failure["input_ref"] == f"org:{seen[0][0]}:{seen[0][1]}"
    assert failure["error"].startswith("RuntimeError: tool blew up")
    assert "sekret-123" not in failure["error"]
    db.rollback()  # whatever the run did is committed
    assert count(db, "pending_merges") == 1 and count(db, "org_merges") == 0


def test_database_error_in_one_pair_is_rolled_back_and_the_pass_continues(db, monkeypatch):
    _two_pairs(db)
    calls = []

    def decide(pair, deps, *, provider=None):
        calls.append(pair)
        if len(calls) == 1:
            deps.conn.execute("SELECT * FROM no_such_table")  # leaves the transaction failed
        return agent.Outcome(decision=UNSURE, run_id=None, error=None)

    monkeypatch.setattr(agent, "decide", decide)
    stats = _run(db)
    assert len(calls) == 2
    assert stats["failed"] == 1 and stats["pending"] == 1
    assert "UndefinedTable" in stats["failures"][0]["error"]
    assert stats["pending_total"] == 1


def test_apply_failure_of_any_kind_is_counted_not_raised(db, monkeypatch):
    _two_pairs(db)
    monkeypatch.setattr(
        agent, "decide", lambda pair, deps, *, provider=None: agent.Outcome(UNSURE, None, None)
    )
    real = apply.apply_decision
    calls = []

    def flaky(conn, pair, decision, **kwargs):
        calls.append(pair)
        if len(calls) == 1:
            raise ValueError("unexpected")
        return real(conn, pair, decision, **kwargs)

    monkeypatch.setattr(apply, "apply_decision", flaky)
    stats = _run(db)
    assert stats["failed"] == 1 and stats["pending"] == 1
    assert stats["failures"][0]["error"] == "apply failed: ValueError: unexpected"


def test_keyboard_interrupt_still_propagates(db, monkeypatch):
    _two_pairs(db)

    def decide(pair, deps, *, provider=None):
        raise KeyboardInterrupt

    monkeypatch.setattr(agent, "decide", decide)
    with pytest.raises(KeyboardInterrupt):
        _run(db)


def test_uei_auto_merges_commit_one_by_one_and_survive_a_database_error(db, monkeypatch):
    usa = org(
        db, "LEIDOS, INC.", uei="UE9QJD4KK1L6", source="usaspending", source_id="uei:UE9QJD4KK1L6"
    )
    dod = org(db, "Leidos Inc.", uei="UE9QJD4KK1L6", source="dod_contracts")
    third = org(db, "Leidos", uei="UE9QJD4KK1L6", source="z")
    db.commit()
    real = apply.merge
    calls = []

    def flaky(conn, canonical, other, **kwargs):
        calls.append(other)
        if len(calls) == 1:
            conn.execute("SELECT 1")  # work that the failure must roll back
            raise psycopg.errors.DeadlockDetected("deadlock detected")
        return real(conn, canonical, other, **kwargs)

    monkeypatch.setattr(apply, "merge", flaky)
    stats = runner.run(db, limit=10, http=http_client())
    assert calls == [dod, third]
    assert stats["auto_merged"] == 1 and stats["failed"] == 1
    (failure,) = stats["failures"]
    assert failure["input_ref"] == f"org:{usa}:{dod}" and failure["run_id"] is None
    assert "DeadlockDetected" in failure["error"]
    db.rollback()  # the successful merge was committed on its own
    assert db.execute(
        "SELECT canonical_org_id, merged_org_id FROM org_merges WHERE undone_at IS NULL"
    ).fetchall() == [(usa, third)]

    # The one that failed is simply picked up by the next run.
    monkeypatch.setattr(apply, "merge", real)
    again = runner.run(db, limit=10, http=http_client())
    assert again["auto_merged"] == 1 and again["failed"] == 0
    assert count(db, "organizations", "merged_into IS NULL AND kind = 'company'") == 1


def test_uei_auto_merge_closes_an_open_review_question(db):
    a = org(db, "Acme One", uei="AAAAAAAAAAAA", source="x")
    b = org(db, "Acme 1", uei="AAAAAAAAAAAA", source="y")
    db.execute(
        "INSERT INTO pending_merges (left_org_id, right_org_id, decision, confidence)"
        " VALUES (%s, %s, 'unsure', 0.5)",
        (a, b),
    )
    db.commit()
    stats = runner.run(db, limit=10, http=http_client())
    assert stats["auto_merged"] == 1 and stats["pending_total"] == 0
    assert count(db, "organizations", "merged_into IS NOT NULL") == 1


def test_spent_model_quota_stops_the_pass(db):
    from pydantic_ai.exceptions import ModelHTTPError
    from pydantic_ai.models.function import FunctionModel

    from pipeline.extract import llm

    _two_pairs(db)
    requests = []

    def respond(messages, info):
        requests.append(1)
        raise ModelHTTPError(429, "m", {"error": {"details": [{"quotaId": "RequestsPerDay"}]}})

    p = llm.Provider(
        name="fake:quota", model=FunctionModel(respond), min_interval=0.0, sleep=lambda s: None
    )
    stats = runner.run(db, limit=10, provider=p, http=http_client())
    # One request, one failure; the second pair is left for the next run.
    assert len(requests) == 1 and stats["candidates"] == 2
    assert stats["failed"] == 1 and stats["stopped"] == "model daily quota exhausted"
    assert count(db, "org_merges") == 0 and count(db, "pending_merges") == 0


def test_spent_anthropic_credit_stops_the_pass(db):
    from pydantic_ai.exceptions import ModelHTTPError
    from pydantic_ai.models.function import FunctionModel

    from pipeline.extract import llm

    _two_pairs(db)
    requests = []

    def respond(messages, info):
        requests.append(1)
        message = "Your credit balance is too low to access the Anthropic API."
        body = {"type": "error", "error": {"type": "invalid_request_error", "message": message}}
        raise ModelHTTPError(400, "claude-haiku-5-5", body)

    p = llm.Provider(
        name="anthropic:claude-haiku-5-5",
        model=FunctionModel(respond),
        min_interval=0.0,
        sleep=lambda s: None,
    )
    stats = runner.run(db, limit=10, provider=p, http=http_client())
    assert len(requests) == 1 and stats["candidates"] == 2
    assert stats["failed"] == 1 and stats["stopped"] == "model credit balance too low"
    assert count(db, "org_merges") == 0 and count(db, "pending_merges") == 0
