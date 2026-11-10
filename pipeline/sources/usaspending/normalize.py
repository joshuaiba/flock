"""Raw USAspending spending_by_award rows -> AwardRecord."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from datetime import date, datetime
from decimal import Decimal

from pipeline.models import AwardRecord, OrgRef

SOURCE = "usaspending"
AWARD_URL = "https://www.usaspending.gov/award/{}"


def _agency(name: str | None, code: str | None, parent: OrgRef | None = None) -> OrgRef | None:
    if not name:
        return None
    return OrgRef(
        source=SOURCE,
        source_id=f"agency:{code or name}",
        canonical_name=name,
        kind="agency",
        parent=parent,
    )


def _recipient(rec: dict) -> OrgRef | None:
    name = rec.get("Recipient Name")
    if not name:
        return None
    uei = rec.get("Recipient UEI") or None
    # Prefer UEI (stable across systems); fall back to USAspending's recipient hash.
    key = f"uei:{uei}" if uei else f"recipient:{rec.get('recipient_id') or name}"
    return OrgRef(source=SOURCE, source_id=key, canonical_name=name, kind="company", uei=uei)


def normalize_line(line: dict) -> AwardRecord:
    rec = line["record"]
    toptier = _agency(rec.get("Awarding Agency"), rec.get("Awarding Agency Code"))
    subtier = _agency(rec.get("Awarding Sub Agency"), rec.get("Awarding Sub Agency Code"), toptier)
    amount = rec.get("Award Amount")
    signed = rec.get("Base Obligation Date")
    gid = rec["generated_internal_id"]
    return AwardRecord(
        source=SOURCE,
        source_id=gid,
        fetched_at=datetime.fromisoformat(line["fetched_at"]),
        recipient=_recipient(rec),
        agency=subtier or toptier,
        amount=Decimal(str(amount)) if amount is not None else None,
        signed_at=date.fromisoformat(signed) if signed else None,
        description=rec.get("Description"),
        url=AWARD_URL.format(gid),
    )


def normalize(lines: Iterable[dict]) -> Iterator[AwardRecord]:
    """Normalize and dedupe (sorting by date can repeat rows across page boundaries)."""
    seen: set[str] = set()
    for line in lines:
        award = normalize_line(line)
        if award.source_id in seen:
            continue
        seen.add(award.source_id)
        yield award
