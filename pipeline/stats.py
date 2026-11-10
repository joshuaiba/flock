"""Per-step run stats, emitted as JSON lines for the CI job summary."""

from __future__ import annotations

import json
import os
import sys


def emit(step: str, stats: dict) -> None:
    line = json.dumps({"step": step, **stats}, sort_keys=True)
    print(line, file=sys.stdout)
    if path := os.environ.get("FLOCK_STATS_FILE"):
        with open(path, "a") as f:
            f.write(line + "\n")
