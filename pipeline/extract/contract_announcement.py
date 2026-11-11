"""Schema + instructions for extracting one DoD contract announcement paragraph."""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_ai import ModelRetry

from pipeline.extract import llm

log = logging.getLogger(__name__)


class Awardee(BaseModel):
    contractor: str = Field(
        description="Company name as written, including any division, without a trailing '*'."
    )
    location: str | None = Field(description="City and state (or country) as written.")
    contract_number: str | None = Field(
        description="This awardee's own contract number if listed next to it, else null."
    )
    small_business: bool = Field(description="True if the name is marked with an asterisk (*).")


class ContractAnnouncement(BaseModel):
    awardees: list[Awardee] = Field(
        description="Every contractor receiving the award. Multiple-award contracts list several."
    )
    amount_usd: float | None = Field(
        description="Headline dollar value of this action, as a plain number (no $ or commas)."
    )
    amount_type: Literal["obligation", "ceiling", "modification", "other"] | None = Field(
        description="'ceiling' for ceiling / maximum / not-to-exceed / IDIQ program values, "
        "'modification' for the value of a modification, 'obligation' for a definitive award."
    )
    contract_number: str | None = Field(
        description="Primary contract or order number. For a modification, the contract being "
        "modified. Null if none is given."
    )
    awarding_office: str | None = Field(
        description="The contracting activity, usually stated as '... is the contracting "
        "activity', including its location."
    )
    description: str = Field(description="One sentence: what is being bought or done.")
    completion_date: date | None = Field(
        description="Expected completion date (ISO 8601), if stated."
    )
    is_modification: bool = Field(description="True if this modifies an existing contract.")


INSTRUCTIONS = """\
You extract structured data from one paragraph of a US Department of Defense daily
contract announcement (contracts valued at $7.5 million or more). Copy names, numbers,
and places as written; do not guess values that are not in the text. Use null when a
field is not stated."""


# --- output checks ------------------------------------------------------------
#
# Hard checks (no awardees, a negative amount) get one ModelRetry and then fail
# the extraction. Contract numbers are softer: they are normalized in place, the
# model gets its one retry for a value with no contract number in it at all,
# and if it still cannot produce one the field is nulled (with a warning) and
# the rest of the award is kept. A malformed number must never cost an award.

_DASHES = dict.fromkeys(
    map(ord, "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d"), "-"
)
# A run of letters/digits, optionally dash-separated: FA8604-25-D-B001,
# N0042125F0043, GS-35F-0119Y.
_TOKEN = re.compile(r"(?<![A-Za-z0-9-])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9-])")


def _piid_shaped(token: str) -> bool:
    """Long enough to be a contract or order number (DoD PIIDs are 13 characters;
    GSA schedule numbers are 10), with letters and at least four digits. Rules
    out bare modification numbers (P00005), phone numbers and ordinary words."""
    chars = token.replace("-", "")
    return (
        8 <= len(chars) <= 25
        and sum(c.isdigit() for c in chars) >= 4
        and any(c.isalpha() for c in chars)
    )


def normalize_contract_number(value: str) -> str | None:
    """The first contract-number-shaped token in `value`, or None if there is none.

    Models often return a combined string for a modification or an order:
    "FA8626-22-D-0010 (P00005)", "N0001921G0006 (order N0001924F0259)". We keep
    the first contract number as written (case and dashes preserved), after
    mapping Unicode dashes to "-" and ignoring surrounding punctuation.
    """
    for m in _TOKEN.finditer(value.translate(_DASHES)):
        if _piid_shaped(m.group()):
            return m.group()
    return None


def plausible_contract_number(value: str) -> bool:
    return normalize_contract_number(value) is not None


def check(output: ContractAnnouncement, final: bool = False) -> None:
    """Output validator. `final` is true on the model's last attempt."""
    problems = []
    if not output.awardees:
        problems.append("awardees is empty; every announcement names at least one contractor")
    if output.amount_usd is not None and output.amount_usd < 0:
        problems.append(f"amount_usd is negative ({output.amount_usd}); dollar values are >= 0")

    holders = [("contract_number", output)] + [
        (f"awardees[{i}].contract_number", a) for i, a in enumerate(output.awardees)
    ]
    unusable = []
    for label, holder in holders:
        if holder.contract_number is None:
            continue
        normalized = normalize_contract_number(holder.contract_number)
        if normalized is None:
            unusable.append((label, holder))
        else:
            holder.contract_number = normalized
    # Give up on the numbers only when nothing else is wrong: if a hard check
    # is failing too, the extraction fails anyway.
    if unusable and final and not problems:
        for label, holder in unusable:
            log.warning(
                "%s %r is not a contract number after a retry; storing null",
                label,
                holder.contract_number,
            )
            holder.contract_number = None
        unusable = []
    for label, holder in unusable:
        problems.append(
            f"{label} {holder.contract_number!r} does not look like a contract number such as "
            "FA8604-25-D-B001 or N0042125F0043; copy it exactly from the text, or use null"
        )
    if problems:
        raise ModelRetry("; ".join(problems))


llm.register_validator(ContractAnnouncement, check)
