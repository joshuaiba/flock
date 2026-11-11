"""Local API server on an embedded Postgres with sample data.

    uv run python -m pipeline.api.dev

Starts pgserver in data/dev-pg (kept between runs), applies migrations, seeds
sample data if the database is empty, and serves the API on :8000. DATABASE_URL
from the shell or .env is ignored on purpose, so this can never touch a real
database. `--reseed` wipes the sample database and starts over.
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

import psycopg
import uvicorn

from pipeline import signals
from pipeline.api import seed
from pipeline.db import migrate

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "dev-pg"


def main(argv: list[str] | None = None) -> None:
    import pgserver  # dev dependency

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reseed", action="store_true", help="wipe the sample database first")
    args = p.parse_args(argv)

    if args.reseed and DATA_DIR.exists():
        shutil.rmtree(DATA_DIR)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = pgserver.get_server(DATA_DIR, cleanup_mode="stop")
    dsn = server.get_uri()
    with psycopg.connect(dsn) as conn:
        for name in migrate(conn):
            print(f"applied {name}")
        if conn.execute("SELECT count(*) FROM awards").fetchone()[0] == 0:
            print(f"seeded sample data: {seed.seed(conn)}")
        # Windows end on the day of the refresh, so refresh on every start.
        signals.refresh(conn)
    os.environ["DATABASE_URL"] = dsn
    try:
        uvicorn.run("pipeline.api.app:app", host="127.0.0.1", port=args.port)
    finally:
        server.cleanup()


if __name__ == "__main__":
    main()
