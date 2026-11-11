"""Refresh the signal materialized views (migrations/007_signals.sql).

    uv run --env-file .env python -m pipeline.signals

Runs last in the nightly pipeline, after loading, classification and
organization merges, so the dashboard's numbers reflect that night's data. All
views are refreshed in one transaction: readers see either the old set or the
new set, never a mix, and every signal shares one `as_of` date.
"""

from __future__ import annotations

import psycopg

from pipeline import db
from pipeline.stats import emit

# Dependency order: signal_meta fixes as_of, the two snapshots feed the rest,
# and signal_transitions is built from signal_stages.
VIEWS = [
    "signal_meta",
    "signal_awards",
    "signal_opportunities",
    "signal_funding",
    "signal_companies",
    "signal_stages",
    "signal_transitions",
    "signal_solicitations",
    "signal_daily",
]


def refresh(conn: psycopg.Connection) -> dict[str, int]:
    """Recompute every signal view. Returns the row count of each."""
    counts: dict[str, int] = {}
    with conn.transaction():
        for view in VIEWS:
            conn.execute(f"REFRESH MATERIALIZED VIEW {view}")
        for view in VIEWS:
            counts[view] = conn.execute(f"SELECT count(*) FROM {view}").fetchone()[0]
    conn.commit()
    return counts


def main() -> None:
    with db.connect() as conn:
        counts = refresh(conn)
        as_of = conn.execute("SELECT as_of FROM signal_meta").fetchone()[0]
    print(f"signals refreshed as of {as_of}")
    for view, n in counts.items():
        print(f"  {view}: {n} rows")
    emit("signals", {"as_of": str(as_of), **counts})


if __name__ == "__main__":
    main()
