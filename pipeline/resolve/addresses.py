"""Deterministic US address normalization and comparison (stdlib only).

Not a geocoder: it canonicalizes case, punctuation, USPS street-suffix,
directional and unit abbreviations and ZIP+4, then compares the pieces. The
resolver agent leans on this instead of eyeballing address strings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from pipeline.resolve.models import AddressComparison

# USPS Publication 28 abbreviations (the common ones).
SUFFIXES = {
    "STREET": "ST",
    "AVENUE": "AVE",
    "AV": "AVE",
    "BOULEVARD": "BLVD",
    "ROAD": "RD",
    "DRIVE": "DR",
    "LANE": "LN",
    "COURT": "CT",
    "PLACE": "PL",
    "PARKWAY": "PKWY",
    "PKY": "PKWY",
    "HIGHWAY": "HWY",
    "CIRCLE": "CIR",
    "TERRACE": "TER",
    "TRAIL": "TRL",
    "SQUARE": "SQ",
    "PLAZA": "PLZ",
    "EXPRESSWAY": "EXPY",
    "FREEWAY": "FWY",
    "TURNPIKE": "TPKE",
    "CENTER": "CTR",
    "CENTRE": "CTR",
}
SUFFIX_TOKENS = set(SUFFIXES.values()) | {"WAY", "ROW", "LOOP", "PIKE"}
DIRECTIONS = {
    "NORTH": "N",
    "SOUTH": "S",
    "EAST": "E",
    "WEST": "W",
    "NORTHEAST": "NE",
    "NORTHWEST": "NW",
    "SOUTHEAST": "SE",
    "SOUTHWEST": "SW",
}
UNITS = {
    "SUITE": "STE",
    "APARTMENT": "APT",
    "BUILDING": "BLDG",
    "ROOM": "RM",
}
UNIT_TOKENS = {"STE", "APT", "UNIT", "BLDG", "RM"}
OTHER = {"FORT": "FT", "SAINT": "ST", "MOUNT": "MT", "FLOOR": "FL"}
TOKEN_MAP = {**SUFFIXES, **DIRECTIONS, **UNITS, **OTHER}

STATES = {
    "ALABAMA": "AL",
    "ALASKA": "AK",
    "ARIZONA": "AZ",
    "ARKANSAS": "AR",
    "CALIFORNIA": "CA",
    "COLORADO": "CO",
    "CONNECTICUT": "CT",
    "DELAWARE": "DE",
    "DISTRICT OF COLUMBIA": "DC",
    "FLORIDA": "FL",
    "GEORGIA": "GA",
    "HAWAII": "HI",
    "IDAHO": "ID",
    "ILLINOIS": "IL",
    "INDIANA": "IN",
    "IOWA": "IA",
    "KANSAS": "KS",
    "KENTUCKY": "KY",
    "LOUISIANA": "LA",
    "MAINE": "ME",
    "MARYLAND": "MD",
    "MASSACHUSETTS": "MA",
    "MICHIGAN": "MI",
    "MINNESOTA": "MN",
    "MISSISSIPPI": "MS",
    "MISSOURI": "MO",
    "MONTANA": "MT",
    "NEBRASKA": "NE",
    "NEVADA": "NV",
    "NEW HAMPSHIRE": "NH",
    "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM",
    "NEW YORK": "NY",
    "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND",
    "OHIO": "OH",
    "OKLAHOMA": "OK",
    "OREGON": "OR",
    "PENNSYLVANIA": "PA",
    "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD",
    "TENNESSEE": "TN",
    "TEXAS": "TX",
    "UTAH": "UT",
    "VERMONT": "VT",
    "VIRGINIA": "VA",
    "WASHINGTON": "WA",
    "WEST VIRGINIA": "WV",
    "WISCONSIN": "WI",
    "WYOMING": "WY",
    "PUERTO RICO": "PR",
    "GUAM": "GU",
}
STATE_CODES = set(STATES.values())
# Longest names first, so "WEST VIRGINIA" is not read as "VIRGINIA".
_STATE_NAMES = sorted(STATES, key=lambda n: -len(n.split()))
COUNTRY_TAILS = (["UNITED", "STATES", "OF", "AMERICA"], ["UNITED", "STATES"], ["USA"], ["US"])

_ZIP = re.compile(r"\b(\d{5})(?:-?\d{4})?\b")


@dataclass(frozen=True)
class ParsedAddress:
    normalized: str
    street: str  # street line without the unit
    street_number: str | None
    unit: str | None
    state: str | None
    zip5: str | None


def _pop_tail(segments: list[list[str]], tail: list[str]) -> bool:
    flat = [(i, j) for i, seg in enumerate(segments) for j in range(len(seg))]
    if len(flat) < len(tail):
        return False
    idx = flat[-len(tail) :]
    if [segments[i][j] for i, j in idx] != tail:
        return False
    for i, j in reversed(idx):
        del segments[i][j]
    return True


def parse(address: str) -> ParsedAddress:
    s = address.upper().replace(".", "").replace("'", "")
    s = re.sub(r"#\s*", " UNIT ", s)

    # ZIP: the last 5-digit group that is not the leading house number.
    zip5 = None
    zips = [m for m in _ZIP.finditer(s) if s[: m.start()].strip()]
    if zips:
        m = zips[-1]
        zip5 = m.group(1)
        s = s[: m.start()] + " " + s[m.end() :]

    has_commas = "," in s
    segments = [re.sub(r"[^A-Z0-9]+", " ", seg).split() for seg in s.split(",")]
    segments = [seg for seg in segments if seg]

    for tail in COUNTRY_TAILS:
        if _pop_tail(segments, tail):
            break

    # State: only at the very end, and only when the string is clearly more
    # than a street line ("12 OAK CT" is a court, not Connecticut).
    state = None
    if zip5 or has_commas:
        for name in _STATE_NAMES:
            if _pop_tail(segments, name.split()):
                state = STATES[name]
                break
        else:
            flat = [t for seg in segments for t in seg]
            if flat and flat[-1] in STATE_CODES and _pop_tail(segments, [flat[-1]]):
                state = flat[-1]

    segments = [[TOKEN_MAP.get(t, t) for t in seg] for seg in segments if seg]
    # "P O BOX 12" / "PO BOX 12" -> "PO BOX 12"
    for seg in segments:
        for i in range(len(seg) - 2):
            if seg[i : i + 3] == ["P", "O", "BOX"]:
                seg[i : i + 3] = ["PO", "BOX"]
                break

    unit = None
    for seg in segments:
        for i, tok in enumerate(seg[:-1]):
            # a designator opening the whole address is a street name, not a unit
            if tok in UNIT_TOKENS and (i > 0 or seg is not segments[0]):
                unit = seg[i + 1]
                del seg[i : i + 2]
                break
        if unit:
            break
    segments = [seg for seg in segments if seg]

    street_tokens = segments[0] if segments else []
    if not has_commas and street_tokens:
        # No commas: the street line ends at the last street-suffix token.
        ends = [i for i, t in enumerate(street_tokens) if t in SUFFIX_TOKENS and i > 0]
        if ends:
            street_tokens = street_tokens[: ends[-1] + 1]
    street = " ".join(street_tokens)
    number = street_tokens[0] if street_tokens and street_tokens[0][0].isdigit() else None

    parts = [" ".join(seg) for seg in segments]
    if unit:
        parts.insert(1, f"UNIT {unit}")
    parts += [p for p in (state, zip5) if p]
    return ParsedAddress(
        normalized=", ".join(parts),
        street=street,
        street_number=number,
        unit=unit,
        state=state,
        zip5=zip5,
    )


def _same(a: str | None, b: str | None) -> bool | None:
    return None if a is None or b is None else a == b


def compare(a: str, b: str) -> AddressComparison:
    pa, pb = parse(a), parse(b)
    similarity = round(SequenceMatcher(None, pa.normalized, pb.normalized).ratio(), 3)
    same_street = bool(pa.street) and pa.street == pb.street
    same_zip = _same(pa.zip5, pb.zip5)
    same_state = _same(pa.state, pb.state)
    same_unit = _same(pa.unit, pb.unit)  # one side omitting its suite is not a conflict
    place_conflict = same_zip is False or same_state is False
    numbers_differ = _same(pa.street_number, pb.street_number) is False

    if same_street and not place_conflict:
        verdict = "same_building_different_unit" if same_unit is False else "same"
    elif place_conflict or numbers_differ or similarity < 0.6:
        verdict = "different"
    else:
        verdict = "unclear"
    return AddressComparison(
        verdict=verdict,
        similarity=similarity,
        same_street=same_street,
        same_unit=same_unit,
        same_zip=same_zip,
        same_state=same_state,
        normalized_a=pa.normalized,
        normalized_b=pb.normalized,
    )
