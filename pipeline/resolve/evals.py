"""Resolver eval: run the real agent over hand-labeled pairs and score it.

    uv run --env-file .env python scripts/eval_resolver.py [--path FILE] [--limit N] [--json]

Manual only, never in CI: it makes live LLM and HTTP calls. `load` and
`score` are pure and unit-tested; `evaluate` is the live part.

What the live part writes: each pair's two organizations are inserted as
temporary rows, the agent runs, and the rows are deleted in the same
transaction before it commits, so no other connection ever sees them. The
commit keeps the run's `agent_runs` rows (eval spend belongs in the cost
audit) and its `http_cache` rows (so the SAM.gov quota count stays honest and
re-runs are cheap). It only calls `agent.decide`; it never applies a decision.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Literal

import psycopg
import yaml
from pydantic import BaseModel, ConfigDict, model_validator

from pipeline.resolve import candidates
from pipeline.resolve.models import CandidatePair

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "tests" / "evals" / "resolve" / "pairs.yaml"
EVAL_SOURCE = "eval:resolver"

Label = Literal["merge", "separate", "unsure"]
Side = Literal["left", "right"]


class EvalOrg(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    uei: str | None = None


class EvalPair(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    left: EvalOrg
    right: EvalOrg
    expected: Label
    expected_canonical: Side | None = None
    note: str = ""
    todo: bool = False  # true while the pair is an unverified placeholder

    @model_validator(mode="after")
    def _canonical_only_for_merge(self) -> EvalPair:
        if self.expected_canonical is not None and self.expected != "merge":
            raise ValueError("expected_canonical only makes sense with expected: merge")
        return self


class Outcome(BaseModel):
    """What the agent did for one pair. decision is None when the run failed."""

    decision: Label | None = None
    canonical: Side | None = None
    confidence: float | None = None
    reasoning: str = ""
    error: str | None = None
    requests: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0


def load(path: Path = DEFAULT_PATH) -> list[EvalPair]:
    raw = yaml.safe_load(path.read_text()) or {}
    pairs = [EvalPair.model_validate(p) for p in raw.get("pairs", [])]
    ids = [p.id for p in pairs]
    if len(ids) != len(set(ids)):
        raise ValueError(f"duplicate pair ids in {path}")
    return pairs


def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 3) if den else None


def score(examples: list[EvalPair], outcomes: list[Outcome]) -> dict:
    """Pure scoring; examples and outcomes are aligned by index.

    A failed run (decision None) counts as wrong for accuracy and as "not
    merge" for precision/recall. Averages are per pair, failed runs included,
    because a failed run still costs tokens.
    """
    n = len(examples)
    correct = tp = fp = fn = failed = canon_total = canon_right = 0
    misses = []
    for ex, out in zip(examples, outcomes, strict=True):
        failed += out.decision is None
        hit = out.decision == ex.expected
        correct += hit
        pred_merge, gold_merge = out.decision == "merge", ex.expected == "merge"
        tp += pred_merge and gold_merge
        fp += pred_merge and not gold_merge
        fn += gold_merge and not pred_merge
        if pred_merge and gold_merge and ex.expected_canonical:
            canon_total += 1
            canon_right += out.canonical == ex.expected_canonical
        if not hit:
            misses.append(
                {
                    "id": ex.id,
                    "expected": ex.expected,
                    "got": out.decision,
                    "confidence": out.confidence,
                    "reasoning": out.reasoning,
                    "error": out.error,
                }
            )
    tokens = sum(o.input_tokens + o.output_tokens for o in outcomes)
    return {
        "n": n,
        "todo": sum(ex.todo for ex in examples),
        "failed": failed,
        "accuracy": _ratio(correct, n),
        "merge": {
            "precision": _ratio(tp, tp + fp),
            "recall": _ratio(tp, tp + fn),
            "tp": tp,
            "fp": fp,
            "fn": fn,
        },
        "canonical_accuracy": _ratio(canon_right, canon_total),
        "avg_requests": _ratio(sum(o.requests for o in outcomes), n),
        "avg_tool_calls": _ratio(sum(o.tool_calls for o in outcomes), n),
        "avg_tokens": round(tokens / n) if n else None,
        "total_tokens": tokens,
        "misses": misses,
    }


# ---------------------------------------------------------------- live part


def _insert_org(conn: psycopg.Connection, pair_id: str, side: str, org: EvalOrg) -> int:
    return conn.execute(
        """INSERT INTO organizations (canonical_name, uei, kind, source, source_id)
           VALUES (%s, %s, 'company', %s, %s) RETURNING id""",
        (org.name, org.uei, EVAL_SOURCE, f"{pair_id}:{side}"),
    ).fetchone()[0]


def _candidate(ex: EvalPair, left_id: int, right_id: int) -> CandidatePair:
    left_uei, right_uei = ex.left.uei, ex.right.uei
    return CandidatePair(
        left_org_id=left_id,
        right_org_id=right_id,
        left_name=ex.left.name,
        right_name=ex.right.name,
        left_uei=left_uei,
        right_uei=right_uei,
        # Only what blocking could know from two bare names; the rest is unknown.
        signals={
            "name_similarity": candidates.name_similarity(ex.left.name, ex.right.name),
            "name_prefix": candidates.is_token_prefix(ex.left.name, ex.right.name),
            "alias_overlap": False,
            "different_ueis": bool(left_uei and right_uei and left_uei != right_uei),
            "same_state": None,
            "shared_parent": None,
        },
    )


def _run_one(conn: psycopg.Connection, ex: EvalPair, deps, provider) -> Outcome:
    from pipeline.resolve import agent

    since_id = conn.execute("SELECT coalesce(max(id), 0) FROM agent_runs").fetchone()[0]
    left_id = _insert_org(conn, ex.id, "left", ex.left)
    right_id = _insert_org(conn, ex.id, "right", ex.right)
    try:
        result = agent.decide(_candidate(ex, left_id, right_id), deps, provider=provider)
    finally:
        conn.execute("DELETE FROM organizations WHERE id IN (%s, %s)", (left_id, right_id))
        conn.commit()  # temp orgs net out; agent_runs and http_cache rows are kept
    requests, tin, tout, tools = conn.execute(
        """SELECT coalesce(sum(requests), 0), coalesce(sum(input_tokens), 0),
                  coalesce(sum(output_tokens), 0),
                  coalesce(sum(jsonb_array_length(tool_calls)), 0)
           FROM agent_runs WHERE agent_name = %s AND id > %s""",
        (agent.AGENT_NAME, since_id),
    ).fetchone()
    conn.commit()
    out = Outcome(
        error=result.error,
        requests=int(requests),
        input_tokens=int(tin),
        output_tokens=int(tout),
        tool_calls=int(tools),
    )
    if (d := result.decision) is not None:
        out.decision, out.confidence, out.reasoning = d.decision, d.confidence, d.reasoning
        out.canonical = {left_id: "left", right_id: "right"}.get(d.canonical_org_id)
    return out


def evaluate(examples: list[EvalPair], *, on_result=None) -> tuple[dict, list[Outcome]]:
    """Run the real agent on every example. Needs DATABASE_URL and the API key of
    RESOLVE_MODEL's provider (ANTHROPIC_API_KEY by default)."""
    from pipeline.agents import tracing
    from pipeline.db import connect
    from pipeline.http import PoliteClient
    from pipeline.resolve import agent
    from pipeline.resolve.deps import ResolveDeps

    tracing.configure_tracing()
    provider = agent.default_provider()
    outcomes: list[Outcome] = []
    # max_retries is low for the same reason as in runner.py: retries are
    # SAM.gov requests the quota counter cannot see.
    with connect() as conn, PoliteClient(min_interval=1.0, max_retries=1) as http:
        deps = ResolveDeps.from_settings(conn, http)
        for ex in examples:
            out = _run_one(conn, ex, deps, provider)
            outcomes.append(out)
            if on_result:
                on_result(ex, out)
    return score(examples, outcomes), outcomes


def _fmt(value) -> str:
    return "n/a" if value is None else f"{value:.3f}" if isinstance(value, float) else str(value)


def render(report: dict) -> str:
    m = report["merge"]
    lines = [
        f"n={report['n']}  failed runs={report['failed']}",
        f"accuracy            {_fmt(report['accuracy'])}",
        f"merge precision     {_fmt(m['precision'])}  (tp={m['tp']} fp={m['fp']})",
        f"merge recall        {_fmt(m['recall'])}  (fn={m['fn']})",
        f"canonical accuracy  {_fmt(report['canonical_accuracy'])}",
        f"per decision        {_fmt(report['avg_requests'])} requests, "
        f"{_fmt(report['avg_tool_calls'])} tool calls, {_fmt(report['avg_tokens'])} tokens",
        f"total tokens        {report['total_tokens']}",
    ]
    if report["misses"]:
        lines.append(f"\n{len(report['misses'])} misses:")
        for miss in report["misses"]:
            why = miss["error"] or miss["reasoning"]
            lines.append(
                f"- {miss['id']}: expected={miss['expected']} got={miss['got'] or 'FAILED'} "
                f"(confidence {_fmt(miss['confidence'])}) {why}"
            )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--path", type=Path, default=DEFAULT_PATH)
    ap.add_argument("--limit", type=int, default=None, help="only the first N pairs")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    examples = load(args.path)[: args.limit]
    if not examples:
        print(f"no pairs in {args.path}", file=sys.stderr)
        return 1
    if todo := [ex.id for ex in examples if ex.todo]:
        print(
            f"WARNING: {len(todo)} of {len(examples)} pairs are unverified placeholders "
            f"(todo: true): {', '.join(todo)}.\n"
            "WARNING: the numbers below say nothing about real accuracy until they are replaced.",
            file=sys.stderr,
        )

    def progress(ex: EvalPair, out: Outcome) -> None:
        mark = "ok  " if out.decision == ex.expected else "MISS"
        print(f"{mark} {ex.id}: {out.decision or 'FAILED'}", file=sys.stderr)

    report, _ = evaluate(examples, on_result=progress)
    print(json.dumps(report, indent=2) if args.json else render(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
