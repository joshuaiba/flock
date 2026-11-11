"""Postgres-backed cache for the resolver's external lookups (`http_cache`).

    resp = http_cache.cached_request(conn, http, "GET", url, params={...},
                                     secret_params={"api_key": key}, quota=10)

- Key: sha256 of method + URL + sorted params + JSON body. Secrets are passed
  separately (`secret_params`), are never part of the key, and are never
  stored: the row holds only the secret-free URL and params.
- 200 and 404 are definitive and served from the cache for TTL (30 days:
  registrations and parent links change rarely, and re-asking costs quota).
  Any other status (403, 429, 5xx) is stored too, but only served for
  ERROR_TTL (1 hour), so a failing upstream is not hammered and the request
  still counts against the day's quota. Transport errors store nothing.
- Quota: `requests_today(conn, host)` counts rows fetched since 00:00 UTC.
  Cache hits do not count. PoliteClient's internal retries of 429/5xx are not
  counted individually, so keep a margin if the upstream is flaky.

Commit expectations: this is the only table resolver tools write. Each row is
upserted inside `conn.transaction()`: its own committed transaction if the
connection is idle, otherwise a savepoint in the caller's transaction. A
caller that rolls back loses the rows (and with them the quota count), so the
runner should commit after each agent run, including failed ones.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import httpx
import psycopg
from psycopg.types.json import Jsonb

from pipeline.agents.run_log import redact, redact_value
from pipeline.http import PoliteClient

log = logging.getLogger(__name__)

TTL = timedelta(days=30)
ERROR_TTL = timedelta(hours=1)
DEFINITIVE_STATUSES = frozenset({200, 404})


class QuotaExhausted(Exception):
    """The host's daily request quota is used up; nothing was fetched."""


@dataclass(frozen=True)
class CachedResponse:
    status: int
    body: Any  # parsed JSON, or None if the response was not JSON
    from_cache: bool


class _RedactFilter(logging.Filter):
    """httpx logs full request URLs (query string included) at INFO."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact(record.getMessage())
            record.args = None
        except Exception:  # never break logging
            pass
        return True


_filter = _RedactFilter()
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).addFilter(_filter)


def cache_key(method: str, url: str, params: dict | None, json_body: Any = None) -> str:
    """Stable key for a request. `params` must not contain secrets."""
    payload = json.dumps(
        [method.upper(), url, sorted((params or {}).items()), json_body],
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def requests_today(conn: psycopg.Connection, host: str) -> int:
    """Requests actually sent to `host` since 00:00 UTC (cache hits excluded)."""
    return conn.execute(
        """SELECT count(*) FROM http_cache
           WHERE host = %s
             AND fetched_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'""",
        (host,),
    ).fetchone()[0]


def _lookup(conn: psycopg.Connection, key: str) -> CachedResponse | None:
    row = conn.execute(
        "SELECT status, body, now() - fetched_at FROM http_cache WHERE cache_key = %s", (key,)
    ).fetchone()
    if row is None:
        return None
    status, body, age = row
    if age > (TTL if status in DEFINITIVE_STATUSES else ERROR_TTL):
        return None
    return CachedResponse(status=status, body=body, from_cache=True)


def cached_request(
    conn: psycopg.Connection,
    http: PoliteClient,
    method: str,
    url: str,
    *,
    params: dict[str, str] | None = None,
    json_body: Any = None,
    secret_params: dict[str, str] | None = None,
    quota: int | None = None,
) -> CachedResponse:
    """Return the cached response for this request, fetching and storing it if needed.

    Raises QuotaExhausted (before sending anything) if a fetch is needed and
    `quota` requests have already been sent to the host today. Transport
    errors propagate as httpx.TransportError; their text may contain the full
    URL, so callers must redact() before surfacing it.
    """
    params = dict(params or {})
    key = cache_key(method, url, params, json_body)
    if (hit := _lookup(conn, key)) is not None:
        return hit

    host = httpx.URL(url).host
    if quota is not None and requests_today(conn, host) >= quota:
        raise QuotaExhausted(f"daily quota of {quota} requests to {host} is used up")

    kwargs: dict[str, Any] = {}
    if params or secret_params:
        kwargs["params"] = {**params, **(secret_params or {})}
    if json_body is not None:
        kwargs["json"] = json_body
    resp = http.request(method, url, **kwargs)
    try:
        body = resp.json()
    except ValueError:
        body = None
    if resp.status_code not in DEFINITIVE_STATUSES:
        log.warning("%s %s -> %s", method, url, resp.status_code)

    stored_params = redact_value({**params, **({"json": json_body} if json_body else {})})
    with conn.transaction():
        conn.execute(
            """INSERT INTO http_cache (cache_key, host, url, params, status, body, fetched_at)
               VALUES (%s, %s, %s, %s, %s, %s, now())
               ON CONFLICT (cache_key) DO UPDATE SET
                   status = EXCLUDED.status, body = EXCLUDED.body, fetched_at = now()""",
            (
                key,
                host,
                redact(url),
                Jsonb(stored_params),
                resp.status_code,
                Jsonb(redact_value(body)) if body is not None else None,
            ),
        )
    return CachedResponse(status=resp.status_code, body=body, from_cache=False)
