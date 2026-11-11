"""Dependencies injected into the resolver's tools (Pydantic AI `deps`).

Tools get everything they touch from here, so tests can hand them a
throwaway database and a mock-transport HTTP client.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import psycopg

from pipeline.agents.settings import Settings, get_settings
from pipeline.http import PoliteClient
from pipeline.resolve.models import CandidatePair

log = logging.getLogger(__name__)


def open_cache_conn(conn: psycopg.Connection) -> psycopg.Connection | None:
    """A second, autocommit connection to the same database as `conn`.

    Used for http_cache / http_requests writes, so the request count is durable
    whatever happens to the caller's transaction and the tools never commit
    the caller's own work. Returns None (the tools then write through `conn`)
    if it cannot be opened.
    """
    try:
        info = conn.info
        dsn = psycopg.conninfo.make_conninfo(info.dsn, password=info.password)
        return psycopg.connect(dsn, autocommit=True)
    except Exception as e:  # e.g. connection limit reached
        log.warning("no separate cache connection (%s); using the main one", type(e).__name__)
        return None


@dataclass
class ResolveDeps:
    conn: psycopg.Connection
    http: PoliteClient  # all fetches go through the polite client
    sam_api_key: str | None = field(default=None, repr=False)  # never in reprs/logs
    sam_daily_quota: int = 10
    # The pair under review; lets the agent's output validator check that
    # canonical_org_id is one of the two ids.
    pair: CandidatePair | None = None
    # Autocommit connection for http_cache / http_requests (see open_cache_conn).
    # agent.decide opens one per run; when None the tools write through `conn`.
    cache_conn: psycopg.Connection | None = field(default=None, repr=False)

    @property
    def cache(self) -> psycopg.Connection:
        return self.cache_conn or self.conn

    @classmethod
    def from_settings(
        cls,
        conn: psycopg.Connection,
        http: PoliteClient,
        settings: Settings | None = None,
        pair: CandidatePair | None = None,
    ) -> ResolveDeps:
        s = settings or get_settings()
        return cls(
            conn=conn,
            http=http,
            sam_api_key=s.sam_api_key.get_secret_value() if s.sam_api_key else None,
            sam_daily_quota=s.sam_daily_quota,
            pair=pair,
        )
