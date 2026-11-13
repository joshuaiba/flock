"""Short display names for graph labels.

Legal names are long and shouted ("AEROVIRONMENT, INC", "Department of the
Army"), and the graph has room for a word or two. These functions turn a
canonical name into the short name a reader would use; the full legal name
stays on the side card.

Companies lose their legal suffix (Inc, LLC, Corp, Co and the like) and stray
punctuation, and an all-caps name is title-cased, keeping acronyms as they are.
A manual table covers brands that rules cannot guess (AeroVironment, L3Harris).
Agencies and offices come from a table of the names the sources actually use,
with a plain fallback for the rest.

Every lookup goes through `_key`, so the tables can be written in any spelling:
"U.S. Special Operations Command" and "US SPECIAL OPERATIONS COMMAND" are the
same key.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Legal-form words dropped from the end of a company name, as whole words.
_SUFFIXES = {
    "INC",
    "INCORPORATED",
    "LLC",
    "PLLC",
    "CORP",
    "CORPORATION",
    "CO",
    "COMPANY",
    "LTD",
    "LIMITED",
    "LP",
    "LLP",
    "PLC",
    # Foreign legal forms.
    "PTY",
    "PTE",
    "GMBH",
    "AG",
    "SA",
    "AS",
    "AB",
    "OY",
    "OU",
    "NV",
    "SRL",
    "SARL",
}

# Kept in capitals however the name is written.
_ACRONYMS = {
    "AI",
    "APL",
    "ASRC",
    "BAE",
    "CACI",
    "CNA",
    "FLIR",
    "GE",
    "GPS",
    "HII",
    "IBM",
    "ISR",
    "IT",
    "JV",
    "KCI",
    "MIT",
    "MTSI",
    "PNT",
    "RF",
    "SAIC",
    "SOF",
    "UAS",
    "UAV",
    "UGV",
    "UK",
    "US",
    "USA",
    "USV",
    "UUV",
}

# Short consonant-only words that are abbreviations, not acronyms.
_ABBREVIATIONS = {"MFG", "INTL", "NATL", "SVCS", "SVC", "GRP", "CTR", "ST", "MT", "FT", "DR"}

# Two-letter words that are words, not initials ("GO", "UP").
_TWO_LETTER_WORDS = {"AM", "AS", "BE", "DO", "GO", "IS", "ME", "MY", "NO", "OR", "SO", "UP", "WE"}

# Lower-cased inside a name, never as its first word.
_SMALL = {"OF", "THE", "AND", "AT", "FOR", "IN", "ON", "BY", "TO", "DE"}

_VOWELS = set("AEIOUY")

# Brand spellings the rules cannot produce, and names worth shortening further.
# Keys are matched against the whole legal name and against the name without its
# legal suffix, so "AEROVIRONMENT" covers "AEROVIRONMENT, INC" and
# "AeroVironment Inc." alike.
COMPANY_NAMES = {
    "AEROVIRONMENT": "AeroVironment",
    "AEVEX AEROSPACE": "AEVEX Aerospace",
    "ANDURIL INDUSTRIES": "Anduril",
    "AT&T MOBILITY": "AT&T Mobility",
    "ATT MOBILITY": "AT&T Mobility",
    "BLUEHALO": "BlueHalo",
    "CACI INTERNATIONAL": "CACI",
    "CARAHSOFT TECHNOLOGY": "Carahsoft",
    "DRONESHIELD": "DroneShield",
    "DZYNE TECHNOLOGIES": "DZYNE",
    "EDGESOURCE": "EdgeSource",
    "FORTEM TECHNOLOGIES": "Fortem",
    "GENERAL ATOMICS": "General Atomics",
    "GENERAL ATOMICS AERONAUTICAL SYSTEMS": "General Atomics",
    "IQINETICS TECHNOLOGIES": "IQinetics",
    "JOHNS HOPKINS UNIVERSITY APPLIED PHYSICS LABORATORY": "Johns Hopkins APL",
    "KESTRELX": "KestrelX",
    "KRATOS DEFENSE & SECURITY SOLUTIONS": "Kratos",
    "KRATOS UNMANNED AERIAL SYSTEMS": "Kratos",
    "L3 TECHNOLOGIES": "L3",
    "L3HARRIS": "L3Harris",
    "L3HARRIS TECHNOLOGIES": "L3Harris",
    "MANTECH INTERNATIONAL": "ManTech",
    "MODALAI": "ModalAI",
    "NORTHROP GRUMMAN SYSTEMS": "Northrop Grumman",
    "PALANTIR TECHNOLOGIES": "Palantir",
    "PALANTIR USG": "Palantir",
    "RED CAT HOLDINGS": "Red Cat",
    "ROBOTIC RESEARCH OPCO": "Robotic Research",
    "SARONIC TECHNOLOGIES": "Saronic",
    "SHIELD AI": "Shield AI",
    "SIERRA NEVADA": "Sierra Nevada",
    "SKYDIO": "Skydio",
    "TELEDYNE FLIR UNMANNED GROUND SYSTEMS": "Teledyne FLIR",
    "TELEDYNE FLIR": "Teledyne FLIR",
    "WINGXPAND": "WingXpand",
}

# Short names for the agencies and offices the sources name: USAspending's
# sub-agencies ("Department of the Army"), the section headers of the DoD
# contract announcements, title-cased ("Air Force", "Defense Logistics Agency"),
# the sample data's offices, and the contracting activities the announcement
# extractor reports. A leading "U.S." or "United States" is ignored on lookup.
AGENCY_NAMES = {
    "Department of Defense": "DoD",
    "Dept of Defense": "DoD",
    "Department of War": "DoD",
    "Office of the Secretary of Defense": "OSD",
    "Department of the Army": "Army",
    "Dept of the Army": "Army",
    "Army": "Army",
    "Department of the Navy": "Navy",
    "Dept of the Navy": "Navy",
    "Navy": "Navy",
    "Department of the Air Force": "Air Force",
    "Dept of the Air Force": "Air Force",
    "Air Force": "Air Force",
    "Marine Corps": "Marine Corps",
    "Space Force": "Space Force",
    "Defense Logistics Agency": "Defense Logistics",
    "Special Operations Command": "SOCOM",
    "USSOCOM": "SOCOM",
    "SOCOM": "SOCOM",
    "Defense Innovation Unit": "DIU",
    "Defense Innovation Unit Experimental": "DIU",
    "Defense Advanced Research Projects Agency": "DARPA",
    "Missile Defense Agency": "Missile Defense",
    "Defense Information Systems Agency": "DISA",
    "Defense Threat Reduction Agency": "DTRA",
    "Defense Contract Management Agency": "DCMA",
    "Defense Contract Audit Agency": "DCAA",
    "Defense Health Agency": "Defense Health",
    "Defense Microelectronics Activity": "DMEA",
    "Defense Finance and Accounting Service": "DFAS",
    "Defense Counterintelligence and Security Agency": "DCSA",
    "Defense Security Cooperation Agency": "DSCA",
    "Defense Commissary Agency": "DeCA",
    "Washington Headquarters Services": "WHS",
    "National Geospatial-Intelligence Agency": "NGA",
    "Transportation Command": "TRANSCOM",
    "USTRANSCOM": "TRANSCOM",
    "Cyber Command": "CYBERCOM",
    "Uniformed Services University of the Health Sciences": "USUHS",
    "Chief Digital and Artificial Intelligence Office": "CDAO",
    "Air Force Research Laboratory": "AFRL",
    "AFWERX": "AFWERX",
    "Air Force Life Cycle Management Center": "AFLCMC",
    "Space Systems Command": "Space Systems Command",
    "Office of Naval Research": "ONR",
    "Naval Sea Systems Command": "NAVSEA",
    "Naval Air Systems Command": "NAVAIR",
    "Naval Information Warfare Systems Command": "NAVWAR",
    "Naval Facilities Engineering Systems Command": "NAVFAC",
    "Naval Supply Systems Command": "NAVSUP",
    "Naval Research Laboratory": "NRL",
    "Naval Surface Warfare Center": "NSWC",
    "Naval Undersea Warfare Center": "NUWC",
    "Naval Air Warfare Center": "NAWC",
    "Marine Corps Systems Command": "MARCORSYSCOM",
    "Army Contracting Command": "Army Contracting",
    "Army Research Laboratory": "ARL",
    "Army Corps of Engineers": "Army Corps of Engineers",
    "Army Futures Command": "Army Futures Command",
}


def _key(name: str) -> str:
    """Upper case, dots and apostrophes dropped ("U.S." -> "US"), "&" spelled
    AND, other punctuation as spaces, and a leading "THE", "US" or "UNITED
    STATES" removed."""
    s = name.upper().replace("&", " AND ")
    s = re.sub(r"[.'’]", "", s)
    s = re.sub(r"[^A-Z0-9]+", " ", s).strip()
    for lead in ("THE ", "US ", "UNITED STATES "):
        if s.startswith(lead) and len(s) > len(lead):
            s = s[len(lead) :]
    return s


_COMPANY_KEYS = {_key(k): v for k, v in COMPANY_NAMES.items()}
_AGENCY_KEYS = {_key(k): v for k, v in AGENCY_NAMES.items()}


@dataclass
class _Word:
    text: str
    acronym: bool = False  # written with dots, like "S.C.A."


_DOTTED = re.compile(r"^(?:[A-Za-z]\.){2,}[A-Za-z]?$|^(?:[A-Za-z]\.)+[A-Za-z]\.?$")


def _words(name: str) -> list[_Word]:
    """Split on spaces and commas, keeping "&", inner hyphens and apostrophes.
    Dotted initials ("U.S.", "L.L.C.") become one word marked as an acronym; a
    lone dash or other punctuation disappears."""
    out: list[_Word] = []
    for raw in re.split(r"[\s,;/]+", name):
        if _DOTTED.match(raw):
            out.append(_Word(raw.replace(".", ""), acronym=True))
            continue
        text = re.sub(r"[^\w&'’-]", "", raw.replace(".", "")).strip("-'’_")
        if text:
            out.append(_Word(text))
    return out


def _cap(part: str) -> str:
    """One all-caps word in title case: "O'NEIL" -> "O'Neil", "MCKAY" -> "McKay"."""
    if "'" in part:
        head, _, tail = part.partition("'")
        return f"{_cap(head)}'{_cap(tail) if len(head) == 1 else tail.lower()}"
    if part.startswith("MC") and len(part) > 3:
        return "Mc" + part[2:].capitalize()
    return part.capitalize()


def _title_word(w: _Word, first: bool) -> str:
    t, up = w.text, w.text.upper()
    if w.acronym or up in _ACRONYMS:
        return up
    if any(c.isdigit() for c in t):
        # "R2", "3D" and "R526" stay as written; "3AUTONOMY" -> "3Autonomy".
        return re.sub(r"[A-Z]{3,}", lambda m: m.group().capitalize(), up)
    if "&" in t and len(t) <= 5:
        return up  # "AT&T", "S&K"
    if up in _ABBREVIATIONS:
        return up.capitalize()
    if up in _SMALL and not first:
        return up.lower()
    if t.isalpha() and len(t) == 2 and up not in _TWO_LETTER_WORDS:
        return up  # "EF", "DG"
    if t.isalpha() and len(t) <= 4 and not (set(up) & _VOWELS):
        return up  # "W S", "SRC", "BV"
    if "-" in t:
        return "-".join(_title_word(_Word(p), True) for p in t.split("-"))
    return _cap(up)


def _title(words: list[_Word], shouting: bool) -> str:
    """Title-case an all-caps name; a name already in mixed case keeps its
    capitals, with only small joining words lowered ("Finance And" -> "and")."""
    out = []
    for i, w in enumerate(words):
        if shouting:
            out.append(_title_word(w, i == 0))
        elif i > 0 and w.text.upper() in _SMALL and not w.text.isupper():
            out.append(w.text.lower())
        else:
            out.append(w.text)
    return " ".join(out)


def _shouting(name: str) -> bool:
    return name == name.upper()


def company_name(legal: str) -> str:
    """The short name of a company: "AEROVIRONMENT, INC" -> "AeroVironment",
    "W S DARLEY & CO" -> "W S Darley", "Kestrel UAS Inc." -> "Kestrel UAS"."""
    if (hit := _COMPANY_KEYS.get(_key(legal))) is not None:
        return hit
    words = _words(legal)
    upper = [w.text.upper() for w in words]
    if "DBA" in upper[1:-1]:  # "X LLC DBA Brand": the brand is what people say
        words = words[upper.index("DBA") + 1 :]
    if len(words) > 1 and words[0].text.upper() == "THE":
        words = words[1:]
    stripped = False
    while len(words) > 1:
        last = words[-1].text.upper()
        if last in _SUFFIXES or last == "&" or (stripped and last == "AND"):
            words.pop()
            stripped = True
        else:
            break
    if not words:
        return legal.strip()
    # A name made of nothing but suffixes ("CO INC", "INC") has no core to
    # keep: it is written whole rather than cut down to one of them.
    if words[-1].text.upper() in _SUFFIXES:
        return _title(_words(legal), _shouting(legal)) or legal.strip()
    core = " ".join(w.text for w in words)
    if (hit := _COMPANY_KEYS.get(_key(core))) is not None:
        return hit
    return _title(words, _shouting(legal))


# Leading words dropped from an agency name the table does not know.
_AGENCY_PREFIXES = [
    ("DEPARTMENT", "OF", "THE"),
    ("DEPARTMENT", "OF"),
    ("DEPT", "OF", "THE"),
    ("DEPT", "OF"),
    ("UNITED", "STATES"),
    ("US",),
    ("THE",),
]


def agency_name(name: str) -> str:
    """The short name of an agency or office: "Department of the Army" ->
    "Army", "U.S. Special Operations Command" -> "SOCOM". A contracting
    activity with its location ("Naval Air Systems Command, Patuxent River,
    Maryland") is looked up by the part before the first comma, and a known
    command followed by a division by the command. Names the table does not
    know lose a "Department of (the)" prefix and are title-cased."""
    head = name.split(",")[0]
    for candidate in (name, head):
        if (hit := _AGENCY_KEYS.get(_key(candidate))) is not None:
            return hit
    # A known command of three words or more, followed by its division or
    # site: "Naval Surface Warfare Center Dahlgren Division" -> "NSWC".
    key = _key(head)
    for known in sorted(_AGENCY_KEYS, key=len, reverse=True):
        if known.count(" ") >= 2 and key.startswith(known + " "):
            return _AGENCY_KEYS[known]
    words = _words(head)
    changed = True
    while changed:
        changed = False
        for prefix in _AGENCY_PREFIXES:
            n = len(prefix)
            # a prefix goes only when a real word is left after it, so
            # "Dept of the" is not cut down to "the"
            rest = words[n:]
            if (
                any(w.text.upper() not in _SMALL for w in rest)
                and tuple(w.text.upper() for w in words[:n]) == prefix
            ):
                words = rest
                changed = True
                break
    if not words:
        return name.strip()
    return _title(words, _shouting(head))


def display_name(name: str | None, kind: str | None) -> str | None:
    """A short label for a graph node: companies and agencies (or offices) get
    one; anything else (solicitations keep their title) gets None."""
    if not name or not name.strip():
        return None
    if kind == "company":
        return company_name(name)
    if kind in ("agency", "office"):
        return agency_name(name)
    return None
