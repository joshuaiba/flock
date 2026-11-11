"""Dependencies injected into the resolver's tools (Pydantic AI `deps`).

Tools get everything they touch from here, so tests can hand them a
throwaway database and a mock-transport HTTP client.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import psycopg

from pipeline.agents.settings import Settings, get_settings
from pipeline.http import PoliteClient
from pipeline.resolve.models import CandidatePair


@dataclass
class ResolveDeps:
    conn: psycopg.Connection
    http: PoliteClient  # all fetches go through the polite client
    sam_api_key: str | None = field(default=None, repr=False)  # never in reprs/logs
    sam_daily_quota: int = 10
    # The pair under review; lets the agent's output validator check that
    # canonical_org_id is one of the two ids.
    pair: CandidatePair | None = None

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
