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

# Raw and abbreviated street-suffix forms, for finding where a street line ends.
_RAW_SUFFIXES = set(SUFFIXES) | SUFFIX_TOKENS
# Raw unit designators (before TOKEN_MAP), for "Suite 200, 6900 Main St, ..." formats.
_UNIT_WORDS = set(UNITS) | UNIT_TOKENS | {"FLOOR", "FL"}
# A number after one of these is a box / route number, never a ZIP.
_NOT_BEFORE_ZIP = {"BOX", "HWY", "HIGHWAY", "ROUTE", "RTE", "RT", "ROAD", "RD", "SR", "CR", "FM"}
# Strings that stand in for "no address on file".
PLACEHOLDERS = {"N", "A", "NA", "UNKNOWN", "UNK", "NONE", "NULL", "TBD", "NOT", "AVAILABLE"}
NUMBER_WORDS = {
    "ONE": "1",
    "TWO": "2",
    "THREE": "3",
    "FOUR": "4",
    "FIVE": "5",
    "SIX": "6",
    "SEVEN": "7",
    "EIGHT": "8",
    "NINE": "9",
    "TEN": "10",
}


@dataclass(frozen=True)
class ParsedAddress:
    normalized: str
    street: str  # street line without the unit; "" when the string has none
    street_number: str | None  # house number, or the box number of a PO box
    unit: str | None
    city: str | None
    state: str | None
    zip5: str | None
    placeholder: bool = False  # empty / "N/A" / "unknown": not an address at all


def _flat(segments: list[list[str]]) -> list[str]:
    return [t for seg in segments for t in seg]


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


def _is_po_box(seg: list[str]) -> bool:
    return seg[:2] == ["PO", "BOX"] and len(seg) >= 3


def _starts_street(seg: list[str]) -> bool:
    return bool(seg) and (seg[0][0].isdigit() or seg[0] in NUMBER_WORDS or _is_po_box(seg))


def _street_index(segments: list[list[str]]) -> int | None:
    return next((i for i, seg in enumerate(segments) if _starts_street(seg)), None)


def _state_candidate(flat: list[str]) -> tuple[str, list[str], bool] | None:
    """(code, tokens to pop, is a spelled-out name) for a state at the end of `flat`."""
    for name in _STATE_NAMES:
        words = name.split()
        if flat[-len(words) :] == words:
            return STATES[name], words, True
    if flat and flat[-1] in STATE_CODES:
        return flat[-1], [flat[-1]], False
    return None


def _city_follows_street(before: list[str]) -> bool:
    """In an un-delimited token run, is there a street suffix with a city after it?"""
    return any(t in _RAW_SUFFIXES and 0 < i < len(before) - 1 for i, t in enumerate(before))


def parse(address: str) -> ParsedAddress:
    s = address.upper().replace(".", "").replace("'", "")
    s = re.sub(r"#\s*", " UNIT ", s)
    s = re.sub(r"\b(\d{5})-?\d{4}\b", r"\1", s)  # ZIP+4 -> ZIP
    has_commas = "," in s
    segments = [re.sub(r"[^A-Z0-9]+", " ", seg).split() for seg in s.split(",")]
    segments = [seg for seg in segments if seg]
    placeholder = all(t in PLACEHOLDERS for t in _flat(segments))

    for tail in COUNTRY_TAILS:
        if _pop_tail(segments, tail):
            break

    # "P O BOX 12" -> "PO BOX 12"
    for seg in segments:
        for i in range(len(seg) - 2):
            if seg[i : i + 3] == ["P", "O", "BOX"]:
                seg[i : i + 3] = ["PO", "BOX"]
                break

    # ZIP: only the last token, i.e. after the state or at the very end. A
    # 5-digit house number, box number or route number elsewhere is not a ZIP.
    zip5 = None
    flat = _flat(segments)
    if len(flat) >= 2 and flat[-2] not in _NOT_BEFORE_ZIP:
        if re.fullmatch(r"\d{5}", flat[-1]):
            zip5 = flat[-1]
        elif re.fullmatch(r"\d{3,4}", flat[-1]) and flat[-2] in STATE_CODES:
            zip5 = flat[-1].zfill(5)  # leading zero lost in a numeric column: "CT 6614"
        if zip5:
            _pop_tail(segments, [flat[-1]])
    segments = [seg for seg in segments if seg]

    # Unit first: "Suite 200, 6900 Main St, ...". The street is a later segment.
    unit = None
    if (
        len(segments) >= 2
        and len(segments[0]) >= 2
        and segments[0][0] in _UNIT_WORDS
        and any(_starts_street(seg) for seg in segments[1:])
    ):
        unit = segments[0][1]
        del segments[0]

    # State: at the very end, and only when a city is left in front of it.
    # "12 OAK CT" is a court, and "100 MAIN ST, WASHINGTON" names a city.
    state = None
    flat = _flat(segments)
    cand = _state_candidate(flat)
    if cand:
        code, words, spelled = cand
        before = flat[: -len(words)]
        si = _street_index(segments)
        if has_commas and si is not None and si < len(segments) - 1:
            # the street has its own segment: a city must remain after it
            ok = len(_flat(segments[si + 1 :])) > len(words)
        elif has_commas and si is None:
            ok = bool(before)
        else:
            ok = _city_follows_street(before)
        if ok or (zip5 and not spelled and before):
            _pop_tail(segments, words)
            state = code
    segments = [seg for seg in segments if seg]

    segments = [[TOKEN_MAP.get(t, t) for t in seg] for seg in segments]

    if unit is None:
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

    street_tokens: list[str] = []
    city_tokens: list[str] = []
    si = _street_index(segments)
    if si is not None and si < len(segments) - 1:
        street_tokens = segments[si]
        city_tokens = _flat(segments[si + 1 :])
    elif si is not None:
        # The street segment is the last one: it may run on into the city
        # ("100 MAIN ST DAYTON"). The street ends at its last suffix token.
        tokens = segments[si]
        ends = [i for i, t in enumerate(tokens) if t in SUFFIX_TOKENS and i > 0]
        cut = ends[-1] + 1 if ends else len(tokens)
        street_tokens, city_tokens = tokens[:cut], tokens[cut:]
    elif len(segments) >= 2:
        street_tokens, city_tokens = segments[0], _flat(segments[1:])  # no house number
    else:
        city_tokens = _flat(segments)

    number = None
    if _is_po_box(street_tokens):
        number = street_tokens[2]
    elif street_tokens and street_tokens[0][0].isdigit():
        number = street_tokens[0]
    elif street_tokens and street_tokens[0] in NUMBER_WORDS:
        number = NUMBER_WORDS[street_tokens[0]]
        street_tokens = [number, *street_tokens[1:]]
        segments[si] = street_tokens + segments[si][len(street_tokens) :]

    parts = [" ".join(seg) for seg in segments]
    if unit:
        parts.insert(min(1, len(parts)), f"UNIT {unit}")
    parts += [p for p in (state, zip5) if p]
    return ParsedAddress(
        normalized=", ".join(parts),
        street=" ".join(street_tokens),
        street_number=number,
        unit=unit,
        city=" ".join(city_tokens) or None,
        state=state,
        zip5=zip5,
        placeholder=placeholder,
    )


def _same(a: str | None, b: str | None) -> bool | None:
    return None if a is None or b is None else a == b


def compare(a: str, b: str) -> AddressComparison:
    """Verdict rules (deliberately conservative; the agent treats "same" as evidence):

    - "same" needs all of: an identical street line that has a house number
      (or PO box number); no conflict in city, state or ZIP; and a confirmed
      place, i.e. equal ZIPs, or equal city and equal state.
    - "different" needs a real conflict: different ZIP, state, or city (a city
      mismatch is ignored when the ZIPs match), different house numbers, or
      street lines that are nothing alike.
    - everything else, including any comparison where one side is missing its
      street or its place, or is a placeholder like "N/A", is "unclear".
    """
    pa, pb = parse(a), parse(b)
    similarity = round(SequenceMatcher(None, pa.normalized, pb.normalized).ratio(), 3)
    same_street = bool(pa.street) and pa.street == pb.street
    same_zip = _same(pa.zip5, pb.zip5)
    same_state = _same(pa.state, pb.state)
    same_city = _same(pa.city, pb.city)
    same_unit = _same(pa.unit, pb.unit)  # one side omitting its suite is not a conflict

    has_number = pa.street_number is not None and pb.street_number is not None
    place_conflict = (
        same_zip is False or same_state is False or (same_city is False and same_zip is not True)
    )
    place_confirmed = same_zip is True or (same_city is True and same_state is True)
    numbers_differ = _same(pa.street_number, pb.street_number) is False
    streets_unalike = (
        bool(pa.street and pb.street)
        and not same_street
        and SequenceMatcher(None, pa.street, pb.street).ratio() < 0.6
    )

    if pa.placeholder or pb.placeholder:
        verdict = "unclear"
    elif same_street and has_number and place_confirmed and not place_conflict:
        verdict = "same_building_different_unit" if same_unit is False else "same"
    elif place_conflict or numbers_differ or streets_unalike:
        verdict = "different"
    else:
        verdict = "unclear"
    return AddressComparison(
        verdict=verdict,
        similarity=similarity,
        same_street=same_street,
        same_unit=same_unit,
        same_city=same_city,
        same_zip=same_zip,
        same_state=same_state,
        normalized_a=pa.normalized,
        normalized_b=pb.normalized,
    )
