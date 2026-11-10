"""Precision/recall of the autonomy classifier on tests/evals/autonomy.jsonl.

uv run python -m pipeline.extract.eval_classifier [--path FILE] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from pipeline.extract import classifier

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "tests" / "evals" / "autonomy.jsonl"


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {
        "precision": round(p, 3),
        "recall": round(r, 3),
        "f1": round(f, 3),
        "tp": tp,
        "fp": fp,
        "fn": fn,
    }


def score(examples: list[dict], predictions: list[dict]) -> dict:
    """examples/predictions: [{is_autonomy: bool, tags: [...]}], aligned by index."""
    b = Counter()
    per_tag: dict[str, Counter] = {}
    for gold, pred in zip(examples, predictions, strict=True):
        g, p = gold["is_autonomy"], pred["is_autonomy"]
        b["tp" if g and p else "fp" if p else "fn" if g else "tn"] += 1
        gt, pt = set(gold["tags"]), set(pred["tags"])
        for tag in gt | pt:
            c = per_tag.setdefault(tag, Counter())
            c["tp" if tag in gt and tag in pt else "fp" if tag in pt else "fn"] += 1
    micro = Counter()
    for c in per_tag.values():
        micro.update(c)
    return {
        "n": len(examples),
        "is_autonomy": prf(b["tp"], b["fp"], b["fn"]),
        "tags_micro": prf(micro["tp"], micro["fp"], micro["fn"]),
        "per_tag": {t: prf(c["tp"], c["fp"], c["fn"]) for t, c in sorted(per_tag.items())},
    }


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def evaluate(examples: list[dict], provider=None) -> tuple[dict, list[dict]]:
    tax = classifier.load_taxonomy()
    preds = []
    for ex in examples:
        r = classifier.classify(ex["text"], tax, provider=provider)
        preds.append(
            {
                "is_autonomy": r.is_autonomy,
                "tags": r.tags,
                "confidence": r.confidence,
                "rationale": r.rationale,
            }
        )
    return score(examples, preds), preds


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", type=Path, default=DEFAULT_PATH)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    examples = load(args.path)
    report, preds = evaluate(examples)
    if args.json:
        print(json.dumps(report, indent=2))
        return 0
    a, t = report["is_autonomy"], report["tags_micro"]
    print(f"n={report['n']}")
    print(f"is_autonomy  P={a['precision']:.3f}  R={a['recall']:.3f}  F1={a['f1']:.3f}")
    print(f"tags (micro) P={t['precision']:.3f}  R={t['recall']:.3f}  F1={t['f1']:.3f}")
    for tag, m in report["per_tag"].items():
        print(
            f"  {tag:32s} P={m['precision']:.2f} R={m['recall']:.2f}  "
            f"(tp={m['tp']} fp={m['fp']} fn={m['fn']})"
        )
    misses = [
        (ex, p)
        for ex, p in zip(examples, preds, strict=True)
        if ex["is_autonomy"] != p["is_autonomy"] or set(ex["tags"]) != set(p["tags"])
    ]
    if misses:
        print(f"\n{len(misses)} mismatches:")
        for ex, p in misses:
            print(
                f"- {ex['id']}: gold={ex['is_autonomy']} {ex['tags']} "
                f"pred={p['is_autonomy']} {p['tags']} ({p['rationale']})"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
