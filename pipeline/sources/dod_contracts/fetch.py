"""Discover and fetch DoD daily contract announcements.

Behavior verified 2026-11-09:
- defense.gov now redirects to war.gov.
- The contracts RSS feed (RSS_URL) is reachable with a descriptive UA and
  lists recent announcements (title, link, pubDate). Its description is
  just a stub, not award text.
- Article pages sit behind Akamai bot protection and return 403 to
  non-browser clients. We never spoof a browser. Instead, in order:
    1. a polite direct GET (works if/when DoD allows it),
    2. Bright Data Web Unlocker, only if BRIGHTDATA_API_KEY and
       BRIGHTDATA_ZONE are both set (an explicit opt-in by the operator),
    3. HTML saved from a browser into the drop folder
       (data/inbox/dod_contracts/*.html), picked up by run.py.
"""

from __future__ import annotations

import logging
import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

from pipeline.http import PoliteClient

log = logging.getLogger(__name__)

SOURCE = "dod_contracts"
RSS_URL = "https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=10"
BRIGHTDATA_URL = "https://api.brightdata.com/request"
INBOX = Path(__file__).resolve().parents[3] / "data" / "inbox" / SOURCE

_ARTICLE_ID = re.compile(r"/Article/(\d+)/")
_TITLE_DATE = re.compile(r"Contracts\s+for\s+([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})", re.I)
_MONTHS = {
    m: i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1
    )
}


class BlockedError(Exception):
    """Article page could not be fetched by any enabled method."""


@dataclass
class Article:
    article_id: str
    url: str
    title: str
    published: datetime | None = None

    @property
    def announced_on(self) -> date | None:
        return title_date(self.title) or (self.published.date() if self.published else None)


def article_id(url: str) -> str | None:
    m = _ARTICLE_ID.search(url)
    return m.group(1) if m else None


def title_date(title: str) -> date | None:
    m = _TITLE_DATE.search(title)
    if not m:
        return None
    month = _MONTHS.get(m.group(1)[:3].lower())
    return date(int(m.group(3)), month, int(m.group(2))) if month else None


def parse_rss(xml_text: str) -> list[Article]:
    out = []
    for item in ET.fromstring(xml_text).iter("item"):
        url = (item.findtext("link") or "").strip()
        aid = article_id(url)
        if not aid:
            continue
        pub = item.findtext("pubDate")
        out.append(
            Article(
                article_id=aid,
                url=url,
                title=(item.findtext("title") or "").strip(),
                published=parsedate_to_datetime(pub) if pub else None,
            )
        )
    return out


def discover(client: PoliteClient) -> list[Article]:
    resp = client.get(RSS_URL)
    resp.raise_for_status()
    return parse_rss(resp.text)


class BrightDataUnlocker:
    """Web Unlocker REST API: POST /request {zone, url, format: raw} -> target body.

    Docs (read 2026-11-09):
    https://docs.brightdata.com/scraping-automation/web-unlocker/send-your-first-request
    """

    def __init__(self, client: PoliteClient, api_key: str, zone: str):
        self.client, self.api_key, self.zone = client, api_key, zone

    @classmethod
    def from_env(cls, client: PoliteClient) -> BrightDataUnlocker | None:
        key, zone = os.environ.get("BRIGHTDATA_API_KEY"), os.environ.get("BRIGHTDATA_ZONE")
        return cls(client, key, zone) if key and zone else None

    def fetch(self, url: str) -> str:
        resp = self.client.post(
            BRIGHTDATA_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={"zone": self.zone, "url": url, "format": "raw"},
        )
        if resp.status_code != 200:
            raise BlockedError(f"bright data {resp.status_code}: {resp.text[:200]}")
        return resp.text


def fetch_article_html(
    client: PoliteClient, article: Article, unlocker: BrightDataUnlocker | None
) -> tuple[str, str]:
    """Return (html, via). Raises BlockedError if every enabled method fails."""
    resp = client.get(article.url)
    if resp.status_code == 200:
        return resp.text, "direct"
    log.warning("direct fetch of %s -> %s", article.url, resp.status_code)
    if unlocker is None:
        raise BlockedError(
            f"{article.url} returned {resp.status_code}; set BRIGHTDATA_API_KEY + "
            f"BRIGHTDATA_ZONE to enable the unlocker, or save the page into {INBOX}"
        )
    return unlocker.fetch(article.url), "brightdata"
