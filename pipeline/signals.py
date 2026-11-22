"""Refresh the signal materialized views (migrations/007_signals.sql, with the
`as_of` rule from migrations/008_signals_data_anchor.sql).

    uv run --env-file .env python -m pipeline.signals

Runs last in the nightly pipeline, after loading, classification and
organization merges, so the dashboard's numbers reflect that night's data. All
views are refreshed in one transaction: readers see either the old set or the
new set, never a mix, and every signal shares one `as_of` date.

`as_of` is not the day of the refresh. It is the day of the newest autonomy
award on record, and every window ends there: the sources publish contracts
weeks to months after signing, so windows that ended today would be empty. A
refresh that loads nothing new leaves `as_of` where it was.
"""

from __future__ import annotations

import psycopg

from pipeline import db
from pipeline.stats import emit

# Dependency order: the two snapshots feed everything, signal_meta reads as_of
# off the award snapshot (so it must come after it and before the windowed
# signals), and signal_transitions is built from signal_stages.
VIEWS = [
    "signal_awards",
    "signal_opportunities",
    "signal_meta",
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
    anchor = "the newest award on record" if counts["signal_awards"] else "today: no awards"
    print(f"signals refreshed; windows end on {as_of} ({anchor})")
    for view, n in counts.items():
        print(f"  {view}: {n} rows")
    emit("signals", {"as_of": str(as_of), **counts})


if __name__ == "__main__":
    main()
