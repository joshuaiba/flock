"""Refresh the signal materialized views (migrations/007_signals.sql, 008).

    uv run --env-file .env python -m pipeline.signals

Runs last in the nightly pipeline, after loading, classification and
organization merges, so the dashboard's numbers reflect that night's data. All
views are refreshed in one transaction: readers see either the old set or the
new set, never a mix, and every signal shares one `as_of` date.

`as_of` is the day every window ends on: the day of the newest award or
solicitation on record, not the day of the refresh, because the record trails
the calendar (USAspending publishes Defense contracts about 90 days late).
"""

from __future__ import annotations

from datetime import date

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


def refresh(conn: psycopg.Connection, *, as_of: date | None = None) -> dict[str, int]:
    """Recompute every signal view. Returns the row count of each.

    `as_of` pins the day the windows end on for this refresh; by default it is
    the newest record's day (see migrations/008)."""
    counts: dict[str, int] = {}
    with conn.transaction():
        # Local to this transaction: the next refresh is back to the default.
        conn.execute(
            "SELECT set_config('flock.signals_as_of', %s, true)",
            (as_of.isoformat() if as_of else "",),
        )
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
