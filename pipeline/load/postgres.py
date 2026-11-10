"""Idempotent upserts keyed on (source, source_id).

Every upsert uses `RETURNING (xmax = 0)`, which is true only when the row was
freshly inserted. That lets each run report how many rows were genuinely new.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from datetime import UTC, datetime

import psycopg
from psycopg.types.json import Jsonb

from pipeline.models import AwardRecord, OrgRef


class LoadStats(Counter):
    """Counts like {'awards.inserted': 3, 'awards.updated': 1}."""

    def record(self, table: str, inserted: bool) -> None:
        self[f"{table}.{'inserted' if inserted else 'updated'}"] += 1

    def inserted(self, table: str) -> int:
        return self[f"{table}.inserted"]


def upsert_org(conn: psycopg.Connection, org: OrgRef, stats: LoadStats) -> int:
    parent_id = upsert_org(conn, org.parent, stats) if org.parent else None
    aliases = sorted({a for a in org.aliases if a and a != org.canonical_name})
    org_id, inserted = conn.execute(
        """
        INSERT INTO organizations (canonical_name, uei, aliases, kind, source, source_id)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (source, source_id) DO UPDATE SET
            uei = COALESCE(EXCLUDED.uei, organizations.uei),
            -- keep the first-seen canonical name; remember new spellings as aliases
            aliases = ARRAY(
                SELECT DISTINCT a FROM unnest(
                    organizations.aliases || EXCLUDED.aliases || EXCLUDED.canonical_name
                ) AS a
                WHERE a <> organizations.canonical_name
                ORDER BY a
            ),
            fetched_at = now()
        RETURNING id, (xmax = 0)
        """,
        (org.canonical_name, org.uei, aliases, org.kind, org.source, org.source_id),
    ).fetchone()
    stats.record("organizations", inserted)
    if parent_id is not None:
        upsert_edge(
            conn,
            ("organization", org_id, "part_of", "organization", parent_id),
            source=org.source,
            stats=stats,
        )
    return org_id


def upsert_edge(
    conn: psycopg.Connection,
    edge: tuple[str, int, str, str, int],
    *,
    source: str,
    stats: LoadStats,
    evidence_url: str | None = None,
    confidence: float | None = None,
) -> int:
    src_type, src_id, rel, dst_type, dst_id = edge
    source_id = f"{src_type}:{src_id}:{rel}:{dst_type}:{dst_id}"
    edge_id, inserted = conn.execute(
        """
        INSERT INTO edges (src_type, src_id, rel, dst_type, dst_id, evidence_url, confidence,
                           source, source_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (source, source_id) DO UPDATE SET
            evidence_url = COALESCE(EXCLUDED.evidence_url, edges.evidence_url),
            confidence = COALESCE(EXCLUDED.confidence, edges.confidence),
            fetched_at = now()
        RETURNING id, (xmax = 0)
        """,
        (src_type, src_id, rel, dst_type, dst_id, evidence_url, confidence, source, source_id),
    ).fetchone()
    stats.record("edges", inserted)
    return edge_id


def upsert_award(conn: psycopg.Connection, award: AwardRecord, stats: LoadStats) -> int:
    recipient_id = upsert_org(conn, award.recipient, stats) if award.recipient else None
    agency_id = upsert_org(conn, award.agency, stats) if award.agency else None
    award_id, inserted = conn.execute(
        """
        INSERT INTO awards (recipient_id, agency_id, amount, signed_at, description, url,
                            raw_text, extraction, extraction_model,
                            source, source_id, fetched_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (source, source_id) DO UPDATE SET
            recipient_id = EXCLUDED.recipient_id,
            agency_id = EXCLUDED.agency_id,
            amount = EXCLUDED.amount,
            signed_at = EXCLUDED.signed_at,
            description = EXCLUDED.description,
            url = EXCLUDED.url,
            raw_text = COALESCE(EXCLUDED.raw_text, awards.raw_text),
            extraction = COALESCE(EXCLUDED.extraction, awards.extraction),
            extraction_model = COALESCE(EXCLUDED.extraction_model, awards.extraction_model),
            fetched_at = EXCLUDED.fetched_at
        RETURNING id, (xmax = 0)
        """,
        (
            recipient_id,
            agency_id,
            award.amount,
            award.signed_at,
            award.description,
            award.url,
            award.raw_text,
            Jsonb(award.extraction) if award.extraction is not None else None,
            award.extraction_model,
            award.source,
            award.source_id,
            award.fetched_at or datetime.now(UTC),
        ),
    ).fetchone()
    stats.record("awards", inserted)
    for org in award.awardees:
        org_id = upsert_org(conn, org, stats)
        upsert_edge(
            conn,
            ("award", award_id, "awarded_to", "organization", org_id),
            source=award.source,
            stats=stats,
            evidence_url=award.url,
        )
    return award_id


def load_awards(conn: psycopg.Connection, awards: Iterable[AwardRecord]) -> LoadStats:
    """Upsert awards (and their orgs/edges) in one transaction."""
    stats = LoadStats()
    with conn.transaction():
        for award in awards:
            upsert_award(conn, award, stats)
    return stats
