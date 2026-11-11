"""Typed inputs, outputs and tool results for the entity-resolution agent.

Everything the model chooses from a closed set is a Literal, so it cannot
invent values. Tool results are deliberately compact: they are serialized
into the model's context on every subsequent request.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Literal, Self

from pydantic import BaseModel, Field, model_validator

EvidenceSource = Literal["sam", "usaspending", "db", "address", "names"]
ToolStatus = Literal["ok", "not_found", "unavailable"]


class CandidatePair(BaseModel):
    """Two organization rows that might be the same real-world entity."""

    left_org_id: int
    right_org_id: int
    left_name: str
    right_name: str
    left_uei: str | None = None
    right_uei: str | None = None
    # Deterministic blocking signals, e.g. {"name_similarity": 0.93, "same_state": true}.
    signals: dict[str, Any] = Field(default_factory=dict)


class Evidence(BaseModel):
    source: EvidenceSource = Field(
        description="Where this came from: 'sam' (lookup_sam_entity), 'usaspending' "
        "(search_usaspending_recipient), 'db' (get_org_awards), 'address' "
        "(compare_addresses) or 'names' (the names/UEIs given in the prompt)."
    )
    url: str | None = Field(
        description="The source_url / url returned by the tool this came from, else null. "
        "Never invent a URL."
    )
    snippet: str = Field(description="The specific fact, quoted or closely paraphrased.")
    supports: Literal["merge", "separate"] = Field(
        description="Which conclusion this fact supports."
    )


class MergeDecision(BaseModel):
    decision: Literal["merge", "separate", "unsure"] = Field(
        description="'merge' only if both rows are the same legal entity (or a DBA / former "
        "name of it). 'separate' if they are different entities, including parent vs "
        "subsidiary and joint ventures. 'unsure' if the evidence is missing or conflicts."
    )
    canonical_org_id: int | None = Field(
        description="For 'merge': which of the two org ids should survive. Null otherwise."
    )
    confidence: float = Field(ge=0, le=1, description="Confidence in `decision`, 0-1.")
    evidence: list[Evidence] = Field(description="Facts the decision rests on.")
    reasoning: str = Field(description="Two or three sentences weighing the evidence.")

    @model_validator(mode="after")
    def _merge_needs_canonical(self) -> Self:
        if self.decision == "merge" and self.canonical_org_id is None:
            raise ValueError("decision 'merge' requires canonical_org_id")
        return self


# --- tool results -----------------------------------------------------------


class SamEntity(BaseModel):
    uei: str | None
    legal_name: str | None
    dba_name: str | None
    cage_code: str | None
    registration_status: str | None
    address: str | None  # one line, ready for compare_addresses
    state: str | None
    immediate_parent_uei: str | None
    immediate_parent_name: str | None
    ultimate_parent_uei: str | None
    ultimate_parent_name: str | None


class SamLookup(BaseModel):
    status: ToolStatus
    detail: str | None = None  # why it is not_found / unavailable
    source_url: str | None = None  # cite as Evidence.url; never contains the API key
    total_matches: int = 0
    entities: list[SamEntity] = Field(default_factory=list)


class UsaspendingRecipient(BaseModel):
    recipient_id: str
    name: str
    uei: str | None
    level: Literal["P", "C", "R"] | None  # P = parent, C = child, R = standalone recipient
    amount_12mo: float | None
    url: str  # cite as Evidence.url
    # Filled only for the top results (one detail request each):
    alternate_names: list[str] = Field(default_factory=list)
    parent_name: str | None = None
    parent_uei: str | None = None
    other_parents: list[str] = Field(default_factory=list)  # "NAME (UEI)", past/alternate
    address: str | None = None  # one line, ready for compare_addresses
    state: str | None = None


class UsaspendingSearch(BaseModel):
    status: ToolStatus
    detail: str | None = None
    total_matches: int = 0
    recipients: list[UsaspendingRecipient] = Field(default_factory=list)


class OrgAward(BaseModel):
    award_id: int
    signed_at: date | None
    amount: float | None
    agency: str | None
    description: str | None
    source: str
    url: str | None


class OrgAwards(BaseModel):
    org_id: int
    canonical_org_id: int  # differs from org_id when the org was already merged
    name: str
    uei: str | None
    aliases: list[str]
    total_awards: int
    total_amount: float | None
    awards: list[OrgAward]  # most recent first, at most `limit`


class AddressComparison(BaseModel):
    verdict: Literal["same", "same_building_different_unit", "different", "unclear"]
    similarity: float  # 0-1 over the normalized strings
    same_street: bool
    same_unit: bool | None  # null when neither address has a unit
    same_zip: bool | None  # null when either zip is missing
    same_state: bool | None  # null when either state is missing
    normalized_a: str
    normalized_b: str
