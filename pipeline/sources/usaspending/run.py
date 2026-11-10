"""fetch -> raw snapshot -> normalize -> load, for USAspending.

uv run python -m pipeline.sources.usaspending.run [--lookback-days N] [--no-load]
"""

from __future__ import annotations

import argparse
import logging
from datetime import date

from pipeline import config, raw, stats
from pipeline.db import connect
from pipeline.http import PoliteClient
from pipeline.load.postgres import load_awards
from pipeline.sources.usaspending import fetch, normalize

log = logging.getLogger(__name__)


def snapshot_today(today: date, lookback_days: int) -> tuple:
    path = raw.snapshot_path(fetch.SOURCE, today)
    if path.exists():
        log.info("reusing existing snapshot %s", path)
        return path, False
    with PoliteClient(min_interval=1.0) as client:
        lines = list(
            fetch.fetch(
                client, config.keywords(fetch.SOURCE), today=today, lookback_days=lookback_days
            )
        )
    return raw.write_snapshot(fetch.SOURCE, today, lines), True


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--lookback-days", type=int, default=fetch.LOOKBACK_DAYS)
    p.add_argument("--no-load", action="store_true", help="fetch + snapshot only")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    today = date.today()
    path, fetched = snapshot_today(today, args.lookback_days)
    awards = list(normalize.normalize(raw.read_snapshot(path)))
    out = {"snapshot": str(path), "fetched": fetched, "records": len(awards)}
    if not args.no_load:
        with connect() as conn:
            out.update(load_awards(conn, awards))
    stats.emit("usaspending", out)


if __name__ == "__main__":
    main()
