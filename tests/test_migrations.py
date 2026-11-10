import pytest

from pipeline.db import migrate

pytestmark = pytest.mark.db


def test_migration_creates_tables(db):
    tables = {
        r[0]
        for r in db.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
    }
    assert {"organizations", "opportunities", "awards", "tags", "taggings", "edges"} <= tables


def test_migrate_is_idempotent(db):
    assert migrate(db) == []


def test_upsert_on_source_key(db):
    sql = (
        "INSERT INTO organizations (canonical_name, kind, source, source_id)"
        " VALUES (%s, 'company', 'test', 'x1')"
        " ON CONFLICT (source, source_id) DO UPDATE SET canonical_name = EXCLUDED.canonical_name"
    )
    db.execute(sql, ("Acme",))
    db.execute(sql, ("Acme Corp",))
    rows = db.execute("SELECT canonical_name FROM organizations").fetchall()
    assert rows == [("Acme Corp",)]
