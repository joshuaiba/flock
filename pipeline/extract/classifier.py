"""Autonomy classifier: a single-shot Pydantic AI agent over award/opportunity text.

    uv run python -m pipeline.extract.classifier [--limit N]

Classifies entities whose text has no verdict yet under CLASSIFIER_VERSION
(or whose text changed), stores the verdict in `classifications`, and writes
`taggings` for positive verdicts. Bump CLASSIFIER_VERSION when the prompt,
taxonomy, or model changes in a way that should trigger re-classification.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

import psycopg
from pydantic import BaseModel, Field, create_model
from pydantic_ai import Agent, ModelRetry

from pipeline import config, stats
from pipeline.agents import run_log, tracing
from pipeline.db import connect
from pipeline.extract import llm
from pipeline.load.postgres import LoadStats

log = logging.getLogger(__name__)

CLASSIFIER_VERSION = "v1"
SOURCE = f"classifier:{CLASSIFIER_VERSION}"
AGENT_NAME = "classifier"


@dataclass(frozen=True)
class Taxonomy:
    root: str
    tags: dict[str, str]  # slug -> description


def load_taxonomy() -> Taxonomy:
    raw = config.load_yaml("taxonomy.yaml")
    return Taxonomy(root=raw["root"], tags=dict(raw["tags"]))


def schema_for(tax: Taxonomy) -> type[BaseModel]:
    """AutonomyClassification with `tags: list[TagSlug]`, TagSlug being a Literal
    of the taxonomy's slugs (the seed of the tags table), so the model can't invent tags."""
    return _schema_for(tuple(tax.tags))


@lru_cache(maxsize=8)
def _schema_for(slugs: tuple[str, ...]) -> type[BaseModel]:
    slug = Literal[slugs]  # constrains decoding to known slugs
    return create_model(
        "AutonomyClassification",
        is_autonomy=(
            bool,
            Field(
                description="True if this is about uncrewed/autonomous systems or countering them."
            ),
        ),
        tags=(
            list[slug],
            Field(description="All taxonomy tags that apply; empty if is_autonomy is false."),
        ),
        confidence=(float, Field(ge=0, le=1, description="Confidence in is_autonomy, 0-1.")),
        rationale=(str, Field(description="One short sentence citing the deciding words.")),
    )


def instructions(tax: Taxonomy) -> str:
    tag_lines = "\n".join(f"- {slug}: {desc}" for slug, desc in tax.tags.items())
    return f"""\
You classify US Department of Defense contract and solicitation text for a
research database on defense autonomy and drones.

is_autonomy is true when the work is substantially about uncrewed or autonomous
systems (air, sea, ground), their components, software, training or support, or
about countering them. It is false otherwise, even if a keyword matched: judge
by what is actually being bought. Abbreviations and program names can collide
with autonomy terms, and many descriptions are terse, all-caps catalog
entries.

Tags (choose all that apply, only when is_autonomy is true):
{tag_lines}"""


def _check(output) -> None:
    if not output.rationale.strip():
        raise ModelRetry("rationale is empty; give one short sentence citing the deciding words")


def agent_for(tax: Taxonomy) -> Agent:
    """The classifier agent for this taxonomy (cached per tag set and description)."""
    return _agent_for(tax.root, tuple(tax.tags.items()))


@lru_cache(maxsize=8)
def _agent_for(root: str, tags: tuple[tuple[str, str], ...]) -> Agent:
    tax = Taxonomy(root=root, tags=dict(tags))
    schema = schema_for(tax)
    agent = llm.build_agent(schema, instructions=instructions(tax), name=AGENT_NAME)

    @agent.output_validator
    def _validate(output):
        _check(output)
        return output

    return agent


def classify(
    text: str, tax: Taxonomy | None = None, provider=None, *, input_ref: str | None = None
):
    tax = tax or load_taxonomy()
    result = llm.run(
        agent_for(tax), text, provider=provider, agent_name=AGENT_NAME, input_ref=input_ref
    )
    if not result.is_autonomy:
        result.tags = []
    result.tags = sorted(set(result.tags))
    return result


def text_hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


# Text per entity type; must match what classify() sees so text_hash is stable.
CANDIDATES_SQL = """
WITH texts AS (
    SELECT 'award' AS entity_type, id AS entity_id,
           COALESCE(raw_text, description) AS text
    FROM awards
    UNION ALL
    SELECT 'opportunity', id, concat_ws(E'\\n\\n', title, description)
    FROM opportunities
)
SELECT t.entity_type, t.entity_id, t.text
FROM texts t
LEFT JOIN classifications c
  ON c.source = %(source)s AND c.source_id = t.entity_type || ':' || t.entity_id
WHERE t.text IS NOT NULL AND length(trim(t.text)) > 0
  AND (c.id IS NULL OR c.text_hash <> md5(t.text))
ORDER BY t.entity_type, t.entity_id
LIMIT %(limit)s
"""


def sync_tags(conn: psycopg.Connection, tax: Taxonomy) -> dict[str, int]:
    ids = {}
    entries = {tax.root: "Root tag: any autonomy-related entity.", **tax.tags}
    for slug, desc in entries.items():
        ids[slug] = conn.execute(
            """INSERT INTO tags (slug, description, source, source_id)
               VALUES (%s, %s, 'taxonomy', %s)
               ON CONFLICT (source, source_id) DO UPDATE SET description = EXCLUDED.description
               RETURNING id""",
            (slug, desc, slug),
        ).fetchone()[0]
    return ids


def write_verdict(
    conn, entity_type, entity_id, text, result, model, tag_ids, root: str, st: LoadStats
):
    key = f"{entity_type}:{entity_id}"
    _, inserted = conn.execute(
        """INSERT INTO classifications (entity_type, entity_id, is_autonomy, tags, confidence,
                                        rationale, model, text_hash, source, source_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (source, source_id) DO UPDATE SET
               is_autonomy = EXCLUDED.is_autonomy, tags = EXCLUDED.tags,
               confidence = EXCLUDED.confidence, rationale = EXCLUDED.rationale,
               model = EXCLUDED.model, text_hash = EXCLUDED.text_hash, fetched_at = now()
           RETURNING id, (xmax = 0)""",
        (
            entity_type,
            entity_id,
            result.is_autonomy,
            result.tags,
            result.confidence,
            result.rationale,
            model,
            text_hash(text),
            SOURCE,
            key,
        ),
    ).fetchone()
    st.record("classifications", inserted)

    slugs = [root, *result.tags] if result.is_autonomy else []
    keep = [f"{key}:{s}" for s in slugs]
    conn.execute(  # drop tags from a previous verdict that no longer apply
        "DELETE FROM taggings WHERE source = %s AND entity_type = %s AND entity_id = %s"
        " AND NOT (source_id = ANY(%s))",
        (SOURCE, entity_type, entity_id, keep),
    )
    for slug, sid in zip(slugs, keep, strict=True):
        (inserted,) = conn.execute(
            """INSERT INTO taggings (entity_type, entity_id, tag_id, confidence, source, source_id)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (source, source_id) DO UPDATE SET
                   confidence = EXCLUDED.confidence, fetched_at = now()
               RETURNING (xmax = 0)""",
            (entity_type, entity_id, tag_ids[slug], result.confidence, SOURCE, sid),
        ).fetchone()
        st.record("taggings", inserted)


def run(conn: psycopg.Connection, *, limit: int, provider=None, batch: int = 25) -> dict:
    tax = load_taxonomy()
    st = LoadStats()
    with conn.transaction():
        tag_ids = sync_tags(conn, tax)
    rows = conn.execute(CANDIDATES_SQL, {"source": SOURCE, "limit": limit}).fetchall()
    provider = provider or (llm.get_provider() if rows else None)
    out = {"candidates": len(rows), "positive": 0, "failed": 0}
    conn.commit()  # end the read transaction so each batch below really commits
    for start in range(0, len(rows), batch):
        # Commit per batch so partial progress survives. Failures are caught
        # inside the block, so their agent_runs rows are kept too.
        with conn.transaction(), run_log.bind(conn):
            for entity_type, entity_id, text in rows[start : start + batch]:
                try:
                    result = classify(
                        text, tax, provider=provider, input_ref=f"{entity_type}:{entity_id}"
                    )
                except Exception as e:
                    log.error("classify %s:%s failed: %s", entity_type, entity_id, e)
                    out["failed"] += 1
                    continue
                out["positive"] += result.is_autonomy
                write_verdict(
                    conn, entity_type, entity_id, text, result, provider.name, tag_ids, tax.root, st
                )
    return {**out, **st}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=1000, help="max entities to classify this run")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    tracing.configure_tracing()  # no-op unless LOGFIRE_TOKEN is set
    with connect() as conn:
        stats.emit("classifier", run(conn, limit=args.limit))


if __name__ == "__main__":
    main()
