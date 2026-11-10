"""Schema + instructions for extracting one DoD contract announcement paragraph."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


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
