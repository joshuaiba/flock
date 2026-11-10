"""Immutable raw snapshots: data/raw/<source>/<YYYY-MM-DD>.jsonl.

A snapshot is written once, atomically, and never modified. Re-running an
ingestor on the same day reuses the existing snapshot instead of refetching,
which keeps runs idempotent and avoids hitting upstream twice.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Iterator
from datetime import date
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parent.parent / "data" / "raw"


def raw_root() -> Path:
    return Path(os.environ.get("FLOCK_RAW_DIR", DEFAULT_ROOT))


def snapshot_path(source: str, day: date) -> Path:
    return raw_root() / source / f"{day.isoformat()}.jsonl"


def write_snapshot(source: str, day: date, records: Iterable[dict]) -> Path:
    path = snapshot_path(source, day)
    if path.exists():
        raise FileExistsError(f"raw snapshot already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w") as f:
        for rec in records:
            f.write(json.dumps(rec, sort_keys=True, default=str) + "\n")
    tmp.rename(path)
    return path


def read_snapshot(path: Path) -> Iterator[dict]:
    with path.open() as f:
        for line in f:
            if line.strip():
                yield json.loads(line)
