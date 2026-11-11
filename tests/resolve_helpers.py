"""Small builders shared by the resolver tests."""

from __future__ import annotations

import json

from psycopg.types.json import Jsonb

CORE_TABLES = ("organizations", "awards", "opportunities", "edges", "taggings", "classifications")


def org(db, name, *, uei=None, source="t", source_id=None, kind="company", aliases=()) -> int:
    return db.execute(
        "INSERT INTO organizations (canonical_name, uei, aliases, kind, source, source_id)"
        " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (name, uei, list(aliases), kind, source, source_id or name),
    ).fetchone()[0]


def award(db, source_id, *, recipient=None, agency=None, extraction=None, source="t") -> int:
    return db.execute(
        "INSERT INTO awards (recipient_id, agency_id, amount, description, extraction,"
        " source, source_id) VALUES (%s, %s, 100, %s, %s, %s, %s) RETURNING id",
        (
            recipient,
            agency,
            f"award {source_id}",
            Jsonb(extraction) if extraction is not None else None,
            source,
            source_id,
        ),
    ).fetchone()[0]


def edge(db, src_type, src_id, rel, dst_type, dst_id, *, source="t", source_id=None) -> int:
    """An edge keyed the way the loader keys it, unless source_id is given."""
    key = source_id or f"{src_type}:{src_id}:{rel}:{dst_type}:{dst_id}"
    return db.execute(
        "INSERT INTO edges (src_type, src_id, rel, dst_type, dst_id, source, source_id)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (src_type, src_id, rel, dst_type, dst_id, source, key),
    ).fetchone()[0]


def dump(db, tables=CORE_TABLES) -> str:
    """Every row of the knowledge-graph tables, as stable JSON text."""
    out = {}
    for table in tables:
        rows = db.execute(f"SELECT to_jsonb(t) FROM {table} t ORDER BY t.id").fetchall()
        out[table] = [r[0] for r in rows]
    return json.dumps(out, sort_keys=True)


def count(db, table, where="true", params=()) -> int:
    return db.execute(f"SELECT count(*) FROM {table} WHERE {where}", params).fetchone()[0]
