"""RSS discover -> fetch article HTML -> raw snapshot -> split -> llm.extract -> load.

    uv run python -m pipeline.sources.dod_contracts.run [--max-articles N] [--no-load]

Exits 2 if articles were found but none could be fetched (e.g. all 403),
so CI shows the step as failed without blocking the rest of the pipeline.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter
from datetime import UTC, date, datetime

from pipeline import raw, stats
from pipeline.agents import run_log
from pipeline.db import connect
from pipeline.extract import llm
from pipeline.extract.contract_announcement import INSTRUCTIONS, ContractAnnouncement
from pipeline.http import PoliteClient
from pipeline.load.postgres import load_awards
from pipeline.sources.dod_contracts import fetch, normalize

log = logging.getLogger(__name__)


def loaded_article_ids(conn) -> set[str]:
    rows = conn.execute(
        "SELECT DISTINCT split_part(source_id, ':', 1) FROM awards WHERE source = %s",
        (fetch.SOURCE,),
    )
    return {r[0] for r in rows}


def inbox_lines(skip: set[str]) -> list[dict]:
    """Browser-saved pages from data/inbox/dod_contracts/*.html."""
    out = []
    for path in sorted(fetch.INBOX.glob("*.htm*")) if fetch.INBOX.exists() else []:
        html = path.read_text(errors="replace")
        meta = normalize.page_meta(html)
        aid = fetch.article_id(meta.get("url", ""))
        if not aid:
            log.warning("skipping %s: no og:url with an article id", path)
            continue
        if aid in skip:
            continue
        out.append(_line(fetch.Article(aid, meta["url"], meta.get("title", "")), html, "inbox"))
        skip.add(aid)
    return out


def _line(article: fetch.Article, html: str, via: str) -> dict:
    return {
        "article_id": article.article_id,
        "url": article.url,
        "title": article.title,
        "announced_on": article.announced_on.isoformat() if article.announced_on else None,
        "fetched_at": datetime.now(UTC).isoformat(),
        "via": via,
        "html": html,
    }


def fetch_lines(skip: set[str], max_articles: int, counts: Counter) -> list[dict]:
    lines = inbox_lines(skip)
    counts["articles.inbox"] = len(lines)
    with PoliteClient(min_interval=2.0) as client:
        articles = [a for a in fetch.discover(client) if a.article_id not in skip]
        counts["articles.new_in_feed"] = len(articles)
        unlocker = fetch.BrightDataUnlocker.from_env(client)
        for article in articles[:max_articles]:
            try:
                html, via = fetch.fetch_article_html(client, article, unlocker)
            except fetch.BlockedError as e:
                log.error("%s", e)
                counts["articles.blocked"] += 1
                continue
            if not normalize.split_paragraphs(html):
                log.error("%s via %s: no award paragraphs found", article.url, via)
                counts["articles.unparseable"] += 1
                continue
            counts[f"articles.via_{via}"] += 1
            lines.append(_line(article, html, via))
    return lines


def extract_awards(lines: list[dict], existing: dict[str, tuple], counts: Counter) -> list:
    provider = None
    awards = []
    for line in lines:
        announced = date.fromisoformat(line["announced_on"]) if line["announced_on"] else None
        for para in normalize.split_paragraphs(line["html"]):
            counts["paragraphs"] += 1
            source_id = f"{line['article_id']}:{para.index}"
            prior = existing.get(source_id)
            if prior and prior[0] == para.text and prior[1] is not None:
                extraction, model = ContractAnnouncement.model_validate(prior[1]), prior[2]
                counts["extractions.cached"] += 1
            else:
                provider = provider or llm.get_provider()
                try:
                    extraction = llm.extract(
                        para.text,
                        ContractAnnouncement,
                        instructions=INSTRUCTIONS,
                        provider=provider,
                        input_ref=f"{fetch.SOURCE}:{source_id}",
                    )
                except Exception as e:  # one bad paragraph shouldn't sink the day
                    log.error("extraction failed for %s: %s", source_id, e)
                    counts["extractions.failed"] += 1
                    continue
                model = provider.name
                counts["extractions.new"] += 1
            awards.append(
                normalize.to_award(
                    article_id=line["article_id"],
                    url=line["url"],
                    announced_on=announced,
                    fetched_at=datetime.fromisoformat(line["fetched_at"]),
                    paragraph=para,
                    extraction=extraction,
                    model=model,
                )
            )
    return awards


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--max-articles", type=int, default=5)
    p.add_argument("--no-load", action="store_true", help="fetch + snapshot only")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    counts: Counter = Counter()
    conn = None if args.no_load else connect()
    try:
        skip = loaded_article_ids(conn) if conn else set()

        path = raw.snapshot_path(fetch.SOURCE, date.today())
        if path.exists():
            log.info("reusing existing snapshot %s", path)
            lines = list(raw.read_snapshot(path))
        else:
            lines = fetch_lines(skip, args.max_articles, counts)
            if lines:
                raw.write_snapshot(fetch.SOURCE, date.today(), lines)

        out: dict = {"snapshot": str(path) if lines else None, "articles": len(lines), **counts}
        if conn:
            existing = {
                r[0]: r[1:]
                for r in conn.execute(
                    "SELECT source_id, raw_text, extraction, extraction_model FROM awards"
                    " WHERE source = %s AND split_part(source_id, ':', 1) = ANY(%s)",
                    (fetch.SOURCE, [ln["article_id"] for ln in lines]),
                )
            }
            # The SELECTs above opened a transaction. End it, or everything below
            # would only be savepoints inside it and be discarded on close():
            # each agent_runs row and the load must commit on their own.
            conn.commit()
            with run_log.bind(conn):
                awards = extract_awards(lines, existing, counts)
            out.update(counts)
            out.update(load_awards(conn, awards))
            conn.commit()
    finally:
        if conn:
            conn.close()
    stats.emit(fetch.SOURCE, out)
    blocked_everything = counts["articles.blocked"] and not lines
    return 2 if blocked_everything else 0


if __name__ == "__main__":
    sys.exit(main())
