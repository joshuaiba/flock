import psycopg
import pytest

from pipeline.db import MIGRATIONS_DIR, migrate

pytestmark = pytest.mark.db


def test_migration_creates_tables(db):
    tables = {
        r[0]
        for r in db.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
    }
    assert {"organizations", "opportunities", "awards", "tags", "taggings", "edges"} <= tables


def test_migration_004_tables_and_merged_into(db):
    tables = {
        r[0]
        for r in db.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
    }
    assert {"agent_runs", "http_cache", "org_merges", "pending_merges", "org_non_matches"} <= tables
    cols = {
        r[0]
        for r in db.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations'"
        )
    }
    assert "merged_into" in cols


def test_migration_004_can_be_reapplied(db):
    db.execute((MIGRATIONS_DIR / "004_agents_resolution.sql").read_text())


def test_pair_tables_enforce_order_and_one_open_question(db):
    a, b = (
        db.execute(
            "INSERT INTO organizations (canonical_name, kind, source, source_id)"
            " VALUES (%s, 'company', 't', %s) RETURNING id",
            (n, n),
        ).fetchone()[0]
        for n in ("A", "B")
    )
    db.commit()
    pending = (
        "INSERT INTO pending_merges (left_org_id, right_org_id, decision) VALUES (%s, %s, 'unsure')"
    )
    db.execute(pending, (a, b))
    db.commit()
    for sql, args in [
        (pending, (b, a)),  # wrong order
        (pending, (a, b)),  # already an open question for this pair
        ("INSERT INTO org_non_matches (left_org_id, right_org_id) VALUES (%s, %s)", (b, a)),
    ]:
        with pytest.raises(psycopg.errors.IntegrityError):
            db.execute(sql, args)
        db.rollback()
    db.execute("UPDATE pending_merges SET reviewed_at = now(), reviewer_action = 'rejected'")
    db.execute(pending, (a, b))  # reviewed rows don't block a new question


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
