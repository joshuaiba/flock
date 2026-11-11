"""Postgres-backed cache and request log for the resolver's external lookups.

    resp = http_cache.cached_request(conn, http, "GET", url, params={...},
                                     secret_params={"api_key": key}, quota=10)

- Key: sha256 of method + URL + sorted params + JSON body. Secrets are passed
  separately (`secret_params`), are never part of the key, and are never
  stored: the row holds only the secret-free URL and params.
- A 404, and a 200 whose body is a JSON object, are definitive and served from
  the cache for TTL (30 days: registrations and parent links change rarely,
  and re-asking costs quota). Anything else (400, 403, 429, 5xx, or a 200 with
  an HTML / non-object body such as a maintenance page) is stored too, but
  only served for ERROR_TTL (1 hour), so a failing upstream is not hammered.
- Quota: every request actually sent is logged in `http_requests` (migration
  006) BEFORE it goes out, one row per attempt, including attempts that end
  in a transport error. `requests_today(conn, host)` counts those rows since
  00:00 UTC; cache hits are not requests and do not count. The quota check and
  the log insert are one statement. Not counted: PoliteClient's own internal
  retries of 429/5xx/transport errors, so callers with a quota should build
  the client with a low max_retries.

Commit expectations: `http_cache` and `http_requests` are the only tables
resolver tools write. `conn` here is whatever connection the caller hands in:

- an autocommit connection (what `agent.decide` opens for each run and puts
  in `ResolveDeps.cache_conn`): every row is committed the moment it is
  written, independent of the caller's main transaction. The request count
  therefore survives a failed run and a rollback, and nothing in the caller's
  own transaction is committed as a side effect.
- a normal connection (tools called directly, e.g. in tests): the SELECT that
  looks the key up has already opened a transaction, so each write is a
  savepoint inside it and is only durable once the caller commits. A caller
  that rolls back loses the rows and the quota count.
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
_TODAY = "requested_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"


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
        f"SELECT count(*) FROM http_requests WHERE host = %s AND {_TODAY}", (host,)
    ).fetchone()[0]


def is_definitive(status: int, body: Any) -> bool:
    """Worth keeping for TTL: a 404, or a 200 that parsed to a JSON object."""
    return status == 404 or (status == 200 and isinstance(body, dict))


def _lookup(conn: psycopg.Connection, key: str) -> CachedResponse | None:
    row = conn.execute(
        "SELECT status, body, clock_timestamp() - fetched_at FROM http_cache WHERE cache_key = %s",
        (key,),
    ).fetchone()
    if row is None:
        return None
    status, body, age = row
    if age > (TTL if is_definitive(status, body) else ERROR_TTL):
        return None
    return CachedResponse(status=status, body=body, from_cache=True)


def _log_request(conn: psycopg.Connection, host: str, key: str, quota: int | None) -> int | None:
    """Record one outgoing request; None (nothing recorded) if the quota is used up."""
    with conn.transaction():
        row = conn.execute(
            f"""INSERT INTO http_requests (host, cache_key)
                SELECT %(host)s, %(key)s
                WHERE %(quota)s::int IS NULL
                   OR (SELECT count(*) FROM http_requests
                       WHERE host = %(host)s AND {_TODAY}) < %(quota)s::int
                RETURNING id""",
            {"host": host, "key": key, "quota": quota},
        ).fetchone()
    return row[0] if row else None


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
    `quota` requests have already been sent to the host today. HTTP-level
    failures propagate as httpx.HTTPError (the attempt stays in the request
    log); their text may contain the full URL, so callers must redact()
    before surfacing it.
    """
    params = dict(params or {})
    key = cache_key(method, url, params, json_body)
    # Every statement here runs inside conn.transaction(), so a database error
    # is rolled back to a savepoint and never leaves the caller's transaction
    # aborted.
    with conn.transaction():
        hit = _lookup(conn, key)
    if hit is not None:
        return hit

    host = httpx.URL(url).host
    request_id = _log_request(conn, host, key, quota)
    if request_id is None:
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
    if not is_definitive(resp.status_code, body):
        log.warning("%s %s -> %s (served from cache for 1h only)", method, url, resp.status_code)

    stored_params = redact_value({**params, **({"json": json_body} if json_body else {})})
    with conn.transaction():
        conn.execute(
            "UPDATE http_requests SET status = %s WHERE id = %s", (resp.status_code, request_id)
        )
        conn.execute(
            """INSERT INTO http_cache (cache_key, host, url, params, status, body, fetched_at)
               VALUES (%s, %s, %s, %s, %s, %s, clock_timestamp())
               ON CONFLICT (cache_key) DO UPDATE SET
                   status = EXCLUDED.status, body = EXCLUDED.body,
                   fetched_at = clock_timestamp()""",
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
