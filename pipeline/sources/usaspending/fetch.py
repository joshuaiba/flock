"""Fetch DoD contract awards matching autonomy keywords from USAspending.

API: POST https://api.usaspending.gov/api/v2/search/spending_by_award/
Contract: usaspending-api/usaspending_api/api_contracts/contracts/v2/search/spending_by_award.md

Behavior verified against the live API (2026-11-09):
- `keywords` are OR'd; multi-word terms match as phrases.
- `limit` max is 100; pagination via `page` + `page_metadata.hasNext`.
- No documented rate limit, so we stay sequential at ~1 req/s with backoff.
- DoD procurement data is published ~90 days after signing (DoD's FPDS
  reporting delay), so the most recent ~90 days are nearly empty. We look
  back LOOKBACK_DAYS (180) and rely on idempotent upserts to pick up late
  records as they're published.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta

from pipeline.http import PoliteClient

SOURCE = "usaspending"
URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
LOOKBACK_DAYS = 180
PAGE_SIZE = 100
CONTRACT_TYPE_CODES = ["A", "B", "C", "D"]  # BPA call, purchase order, delivery order, definitive
FIELDS = [
    "Award ID",
    "generated_internal_id",
    "Recipient Name",
    "Recipient UEI",
    "recipient_id",
    "Awarding Agency",
    "Awarding Agency Code",
    "Awarding Sub Agency",
    "Awarding Sub Agency Code",
    "Award Amount",
    "Description",
    "Base Obligation Date",
    "Start Date",
    "End Date",
    "Last Modified Date",
    "Contract Award Type",
    "NAICS",
    "PSC",
]


def build_request(keywords: list[str], start: date, end: date, page: int) -> dict:
    return {
        "filters": {
            "award_type_codes": CONTRACT_TYPE_CODES,
            "agencies": [{"type": "awarding", "tier": "toptier", "name": "Department of Defense"}],
            "keywords": keywords,
            "time_period": [
                {
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                    "date_type": "date_signed",
                }
            ],
        },
        "fields": FIELDS,
        "limit": PAGE_SIZE,
        "page": page,
        "sort": "Base Obligation Date",
        "order": "desc",
    }


def fetch(
    client: PoliteClient,
    keywords: list[str],
    *,
    today: date | None = None,
    lookback_days: int = LOOKBACK_DAYS,
    max_pages: int | None = None,
) -> Iterator[dict]:
    """Yield raw snapshot lines: {fetched_at, page, window, record}."""
    end = today or date.today()
    start = end - timedelta(days=lookback_days)
    page = 1
    while True:
        resp = client.post(URL, json=build_request(keywords, start, end, page))
        resp.raise_for_status()
        body = resp.json()
        fetched_at = datetime.now(UTC).isoformat()
        for rec in body["results"]:
            yield {
                "fetched_at": fetched_at,
                "page": page,
                "window": [start.isoformat(), end.isoformat()],
                "record": rec,
            }
        if not body.get("page_metadata", {}).get("hasNext"):
            return
        if max_pages is not None and page >= max_pages:
            return
        page += 1
