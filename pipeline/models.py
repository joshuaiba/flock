"""Normalized records produced by sources and consumed by the loader.

These mirror migrations/ but reference related organizations by value
(OrgRef) rather than by database id; the loader resolves them to ids.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field


class OrgRef(BaseModel):
    source: str
    source_id: str
    canonical_name: str
    kind: Literal["company", "agency", "office"]
    uei: str | None = None
    aliases: list[str] = Field(default_factory=list)
    parent: OrgRef | None = None  # loader writes an (org, part_of, parent) edge


class AwardRecord(BaseModel):
    source: str
    source_id: str
    fetched_at: datetime
    recipient: OrgRef | None = None
    agency: OrgRef | None = None
    amount: Decimal | None = None
    signed_at: date | None = None
    description: str | None = None
    url: str | None = None
