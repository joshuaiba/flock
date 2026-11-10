"""Shared fixtures.

Database tests use TEST_DATABASE_URL if set, otherwise an embedded throwaway
Postgres via pgserver. They never touch DATABASE_URL, so tests can't clobber a
real database.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import psycopg
import pytest

from pipeline.db import migrate

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def pg_server_dsn(tmp_path_factory):
    if url := os.environ.get("TEST_DATABASE_URL"):
        yield url
        return
    pgserver = pytest.importorskip("pgserver")
    srv = pgserver.get_server(tmp_path_factory.mktemp("pg"), cleanup_mode="stop")
    yield srv.get_uri()
    srv.cleanup()


@pytest.fixture
def db(pg_server_dsn):
    """A fresh, migrated database per test."""
    name = f"t_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(pg_server_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    dsn = psycopg.conninfo.make_conninfo(pg_server_dsn, dbname=name)
    conn = psycopg.connect(dsn)
    migrate(conn)
    yield conn
    conn.close()
    with psycopg.connect(pg_server_dsn, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
