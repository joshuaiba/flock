"""Schema + instructions for extracting one DoD contract announcement paragraph."""

from __future__ import annotations

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_ai import ModelRetry

from pipeline.extract import llm


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


# --- output checks: obviously bad values get one ModelRetry -------------------

# DoD PIIDs are 13 characters (N0042125F0043), often written with dashes
# (FA8604-25-D-B001) and sometimes followed by an order or modification number.
# Deliberately permissive: we only reject things that cannot be a contract
# number at all ("N/A", "unknown", a phrase).
_CONTRACT_NUMBER = re.compile(r"[A-Z0-9][A-Z0-9 /-]{6,48}[A-Z0-9]", re.I)


def plausible_contract_number(value: str) -> bool:
    v = value.strip()
    return bool(_CONTRACT_NUMBER.fullmatch(v)) and sum(c.isdigit() for c in v) >= 4


def check(output: ContractAnnouncement) -> None:
    problems = []
    if not output.awardees:
        problems.append("awardees is empty; every announcement names at least one contractor")
    if output.amount_usd is not None and output.amount_usd < 0:
        problems.append(f"amount_usd is negative ({output.amount_usd}); dollar values are >= 0")
    numbers = [("contract_number", output.contract_number)] + [
        (f"awardees[{i}].contract_number", a.contract_number) for i, a in enumerate(output.awardees)
    ]
    for label, number in numbers:
        if number is not None and not plausible_contract_number(number):
            problems.append(
                f"{label} {number!r} does not look like a contract number such as "
                "FA8604-25-D-B001 or N0042125F0043; copy it exactly from the text, or use null"
            )
    if problems:
        raise ModelRetry("; ".join(problems))


llm.register_validator(ContractAnnouncement, check)
