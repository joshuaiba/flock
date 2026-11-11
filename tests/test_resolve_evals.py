"""The resolver eval's YAML and scoring. The live part (real model) is manual only."""

from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from pipeline.extract.llm import Provider
from pipeline.http import PoliteClient
from pipeline.resolve import evals
from pipeline.resolve.deps import ResolveDeps
from pipeline.resolve.evals import EvalPair, Outcome

ROOT = Path(__file__).resolve().parent.parent


def ex(id, expected, canonical=None, **kw):
    return EvalPair(
        id=id,
        left={"name": "A Corp"},
        right={"name": "A Corporation"},
        expected=expected,
        expected_canonical=canonical,
        **kw,
    )


def test_seed_file_is_valid_and_marked_todo():
    pairs = evals.load()
    assert len(pairs) == 5
    assert all(p.todo for p in pairs)  # placeholders until hand-labeled
    assert {p.expected for p in pairs} == {"merge", "separate", "unsure"}
    # No fabricated UEIs in the placeholders.
    assert all(p.left.uei is None and p.right.uei is None for p in pairs)
    assert evals.DEFAULT_PATH.read_text().count("TODO") >= 5


def test_load_rejects_bad_files(tmp_path):
    path = tmp_path / "pairs.yaml"
    row = "{id: a, left: {name: X}, right: {name: Y}, expected: %s}"
    path.write_text(f"pairs:\n  - {row % 'merge'}\n  - {row % 'separate'}\n")
    with pytest.raises(ValueError, match="duplicate"):
        evals.load(path)
    path.write_text(f"pairs:\n  - {row % 'maybe'}\n")
    with pytest.raises(ValidationError):
        evals.load(path)
    path.write_text(
        "pairs:\n  - {id: a, left: {name: X}, right: {name: Y}, expected: separate,"
        " expected_canonical: left}\n"
    )
    with pytest.raises(ValidationError, match="expected_canonical"):
        evals.load(path)


def test_score():
    examples = [
        ex("m-hit", "merge", "left"),
        ex("m-wrong-side", "merge", "left"),
        ex("m-missed", "merge"),
        ex("s-hit", "separate"),
        ex("s-merged", "separate", todo=True),
        ex("u-failed", "unsure"),
    ]
    outcomes = [
        Outcome(decision="merge", canonical="left", requests=3, tool_calls=2, input_tokens=900),
        Outcome(decision="merge", canonical="right", requests=2, tool_calls=1, output_tokens=100),
        Outcome(decision="unsure", reasoning="thin evidence", requests=1),
        Outcome(decision="separate", requests=2, tool_calls=3, input_tokens=200),
        Outcome(decision="merge", canonical="left", confidence=0.95, requests=2),
        Outcome(error="UsageLimitExceeded: tool calls", requests=2, tool_calls=6),
    ]
    r = evals.score(examples, outcomes)
    assert r["n"] == 6 and r["todo"] == 1 and r["failed"] == 1
    assert r["accuracy"] == 0.5  # m-hit, m-wrong-side (decision right), s-hit
    assert r["merge"] == {"precision": 0.667, "recall": 0.667, "tp": 2, "fp": 1, "fn": 1}
    assert r["canonical_accuracy"] == 0.5
    assert r["avg_requests"] == 2.0 and r["avg_tool_calls"] == 2.0
    assert r["total_tokens"] == 1200 and r["avg_tokens"] == 200
    assert [m["id"] for m in r["misses"]] == ["m-missed", "s-merged", "u-failed"]
    assert r["misses"][0]["reasoning"] == "thin evidence"
    assert r["misses"][2]["got"] is None and "UsageLimitExceeded" in r["misses"][2]["error"]
    assert "FAILED" in evals.render(r) and "0.667" in evals.render(r)


def test_score_handles_empty_and_no_merges():
    r = evals.score([], [])
    assert r["accuracy"] is None and r["avg_tokens"] is None
    r = evals.score([ex("s", "separate")], [Outcome(decision="separate")])
    assert r["accuracy"] == 1.0 and r["merge"]["precision"] is None
    assert "n/a" in evals.render(r)


def test_script_is_a_thin_entry_point():
    src = (ROOT / "scripts" / "eval_resolver.py").read_text()
    assert "from pipeline.resolve.evals import main" in src
    assert not list((ROOT / ".github" / "workflows").glob("*eval*"))
    for wf in (ROOT / ".github" / "workflows").glob("*.yml"):
        assert "eval_resolver" not in wf.read_text()  # manual only, never in CI


@pytest.mark.db
def test_run_one_leaves_no_orgs_and_never_merges(db):
    """Scripted model: temp orgs are removed, the audit row is kept, nothing is merged."""

    def model(messages, info):
        ids = [
            int(tok.strip(" ,"))
            for line in messages[0].parts[-1].content.splitlines()
            if '"org_id"' in line
            for tok in [line.split(":")[1]]
        ]
        return ModelResponse(
            parts=[
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "decision": "merge",
                        "canonical_org_id": ids[0],
                        "confidence": 0.95,
                        "evidence": [
                            {"source": "names", "url": None, "snippet": "x", "supports": "merge"}
                        ],
                        "reasoning": "same name",
                    },
                )
            ]
        )

    provider = Provider(name="fake:test", model=FunctionModel(model), min_interval=0)
    http = PoliteClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    deps = ResolveDeps(conn=db, http=http)
    out = evals._run_one(db, ex("p1", "merge", "left"), deps, provider)

    assert out.decision == "merge" and out.canonical == "left" and out.requests == 1
    assert db.execute("SELECT count(*) FROM organizations").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM org_merges").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM pending_merges").fetchone()[0] == 0
    assert db.execute("SELECT status FROM agent_runs").fetchall() == [("ok",)]
    assert evals.score([ex("p1", "merge", "left")], [out])["accuracy"] == 1.0
