"""Deterministic blocking for entity resolution. No LLM here.

Two outputs, both over live company rows (kind = 'company', merged_into IS NULL):

1. `uei_auto_merges`: rows sharing a UEI. The UEI is SAM.gov's unique entity
   id, so these are the same registered entity and are merged without asking
   the agent. Canonical row: the one USAspending loaded under its `uei:` key
   (the most stable source id we have), else the lowest id. UEIs are compared
   stripped and upper-cased, and only a well-formed UEI (12 letters/digits)
   auto-merges: a blank or malformed value proves nothing, so such rows go
   through the name path like any others.

2. `name_pairs`: rows whose normalized names are similar enough to be worth
   the agent's time. Names are lower-cased, stripped of punctuation, legal
   suffixes (Inc, LLC, Corp, ...), "the" and "and"/"&". Rows are only compared
   within a block (same first token of the normalized name), which keeps the
   work far below n². A block of more than MAX_BLOCK_SIZE rows ("general",
   "american", "advanced") is not compared all-against-all; every row in it is
   still compared with (a) the rows sharing its second token, (b) the rows
   sharing a normalized name or alias, and (c) its NEIGHBOR_WINDOW nearest
   neighbours in name order, which catches typos later in the name. A pair's
   score is the best of:
     - difflib ratio of the two normalized names,
     - 1.0 if their name/alias sets overlap after normalization,
     - PREFIX_SCORE if one name's tokens are a prefix of the other's (two or
       more tokens), which is how DoD announcements write divisions:
       "Lockheed Martin Corp., Missiles and Fire Control".
   Pairs scoring >= NAME_THRESHOLD are returned, best first, capped at `limit`.

Signals handed to the agent with each pair:
  name_similarity  difflib ratio of the normalized canonical names
  name_prefix      one name is a token-prefix of the other
  alias_overlap    a name or alias of one equals a name or alias of the other
  different_ueis   both rows have a UEI and they differ (strong "separate" hint;
                   the pair is still sent, because a parent and its subsidiary
                   look exactly like this and the agent should say so)
  same_state       true/false when a state is known for both rows, else null.
                   Organizations have no address column; the only state we can
                   honestly derive is from DoD announcement extractions
                   ("Stratford, Connecticut"), so for USAspending-only rows
                   this is null.
  shared_parent    true/false when both rows have part_of parents, else null

Never re-proposed: pairs in org_non_matches and pairs a reviewer rejected.
A pair with an open pending_merges row is not sent to the agent again, but it
is still auto-merged if the two rows turn out to share a UEI (the merge closes
the open question).
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from difflib import SequenceMatcher

import psycopg

from pipeline.resolve import addresses
from pipeline.resolve.models import CandidatePair

log = logging.getLogger(__name__)

NAME_THRESHOLD = 0.88
PREFIX_SCORE = 0.9
PREFIX_MIN_TOKENS = 2
MAX_BLOCK_SIZE = 400  # larger blocks are sub-blocked instead of compared all-against-all
NEIGHBOR_WINDOW = 25  # name-order neighbours compared within an oversized block
MAX_ALIASES = 20

LEGAL_SUFFIXES = frozenset(
    {
        "inc", "incorporated", "llc", "corp", "corporation", "co", "company", "ltd",
        "limited", "lp", "llp", "plc", "pllc", "pc", "gmbh", "ag", "sa", "nv", "bv", "pty",
    }
)  # fmt: skip
STOPWORDS = frozenset({"the", "and"})

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_UEI = re.compile(r"[A-Z0-9]{12}")


def normalize_uei(uei: str | None) -> str | None:
    """Stripped, upper-cased UEI; None for a missing or blank one."""
    return (uei or "").strip().upper() or None


def is_plausible_uei(uei: str | None) -> bool:
    """A SAM.gov UEI is exactly 12 letters/digits. Anything else is not proof of identity."""
    return bool(uei and _UEI.fullmatch(uei))


def normalize_name(name: str) -> str:
    """Lower-case, drop punctuation, legal suffixes, 'the' and 'and'/'&'."""
    s = name.lower().replace("&", " and ").replace("'", "").replace(".", "")
    tokens = [t for t in _NON_ALNUM.sub(" ", s).split() if t]
    kept = [t for t in tokens if t not in LEGAL_SUFFIXES and t not in STOPWORDS]
    return " ".join(kept or tokens)


def name_similarity(a: str, b: str) -> float:
    """difflib ratio of the normalized names, 0-1."""
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    return round(SequenceMatcher(None, na, nb).ratio(), 3)


def _tokens_prefix(ta: tuple[str, ...], tb: tuple[str, ...]) -> bool:
    short, long = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    return PREFIX_MIN_TOKENS <= len(short) < len(long) and long[: len(short)] == short


def is_token_prefix(a: str, b: str) -> bool:
    """True if one normalized name's tokens are a proper prefix of the other's."""
    return _tokens_prefix(tuple(normalize_name(a).split()), tuple(normalize_name(b).split()))


@dataclass(frozen=True)
class AutoMerge:
    canonical_org_id: int
    other_org_id: int
    uei: str


@dataclass(frozen=True)
class Candidates:
    auto_merges: list[AutoMerge]
    pairs: list[CandidatePair]


@dataclass(frozen=True)
class _Org:
    id: int
    name: str
    uei: str | None  # normalized (see normalize_uei)
    aliases: tuple[str, ...]
    source: str
    source_id: str
    # Normalized once per row; pairs are compared many times.
    norm: str = field(init=False, compare=False)
    tokens: tuple[str, ...] = field(init=False, compare=False)
    names: frozenset[str] = field(init=False, compare=False)

    def __post_init__(self):
        norm = normalize_name(self.name)
        names = {norm, *(normalize_name(a) for a in self.aliases[:MAX_ALIASES])}
        object.__setattr__(self, "norm", norm)
        object.__setattr__(self, "tokens", tuple(norm.split()))
        object.__setattr__(self, "names", frozenset(n for n in names if n))


def _live_companies(conn: psycopg.Connection) -> list[_Org]:
    rows = conn.execute(
        """SELECT id, canonical_name, uei, aliases, source, source_id FROM organizations
           WHERE kind = 'company' AND merged_into IS NULL ORDER BY id"""
    ).fetchall()
    return [_Org(r[0], r[1], normalize_uei(r[2]), tuple(r[3] or ()), r[4], r[5]) for r in rows]


def _excluded_pairs(conn: psycopg.Connection, *, include_open: bool = True) -> set[tuple[int, int]]:
    """Pairs already decided: non-matches and reviewer rejections, plus (unless
    include_open is false) pairs with an open review question."""
    rows = conn.execute(
        """SELECT left_org_id, right_org_id FROM org_non_matches
           UNION
           SELECT left_org_id, right_org_id FROM pending_merges
           WHERE reviewer_action = 'rejected' OR (%s AND reviewed_at IS NULL)""",
        (include_open,),
    ).fetchall()
    return {(r[0], r[1]) for r in rows}


def _pair_key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def uei_auto_merges(conn: psycopg.Connection) -> list[AutoMerge]:
    """(canonical, other) for every live company row sharing a well-formed UEI with another."""
    # An open "unsure" question does not stand in the way of a shared UEI;
    # a recorded non-match (incl. an undone merge) or a reviewer's "different" does.
    excluded = _excluded_pairs(conn, include_open=False)
    by_uei: dict[str, list[_Org]] = defaultdict(list)
    for org in _live_companies(conn):
        if is_plausible_uei(org.uei):
            by_uei[org.uei].append(org)
    out = []
    for uei in sorted(by_uei):
        group = by_uei[uei]
        if len(group) < 2:
            continue
        canonical = min(
            group,
            key=lambda o: (
                not (o.source == "usaspending" and o.source_id.startswith("uei:")),
                o.id,
            ),
        )
        for org in group:
            # A merge someone undid (or a reviewer's "different") is not redone.
            if org.id != canonical.id and _pair_key(canonical.id, org.id) not in excluded:
                out.append(AutoMerge(canonical.id, org.id, uei))
    return out


def _states(conn: psycopg.Connection) -> dict[int, set[str]]:
    """org id -> states seen for it in DoD announcement extractions."""
    rows = conn.execute(
        """SELECT o.id, aw->>'location'
           FROM edges e
           JOIN awards a ON a.id = e.src_id
           JOIN organizations o ON o.id = e.dst_id
           CROSS JOIN LATERAL jsonb_array_elements(a.extraction->'awardees') AS aw
           WHERE e.src_type = 'award' AND e.rel = 'awarded_to' AND e.dst_type = 'organization'
             AND jsonb_typeof(a.extraction->'awardees') = 'array'
             AND aw->>'location' IS NOT NULL
             AND (aw->>'contractor' = o.canonical_name OR aw->>'contractor' = ANY(o.aliases))"""
    ).fetchall()
    out: dict[int, set[str]] = defaultdict(set)
    for org_id, location in rows:
        # "City, State": a leading comma makes the parser read it as a place, not a street.
        state = addresses.parse(f", {location}").state
        if state:
            out[org_id].add(state)
    return out


def _parents(conn: psycopg.Connection) -> dict[int, set[int]]:
    rows = conn.execute(
        """SELECT src_id, dst_id FROM edges
           WHERE src_type = 'organization' AND rel = 'part_of' AND dst_type = 'organization'"""
    ).fetchall()
    out: dict[int, set[int]] = defaultdict(set)
    for src, dst in rows:
        out[src].add(dst)
    return out


def _overlap(a: set | None, b: set | None) -> bool | None:
    return None if not a or not b else bool(a & b)


def _all_pairs(orgs: list[_Org]) -> Iterator[tuple[_Org, _Org]]:
    for i, left in enumerate(orgs):
        for right in orgs[i + 1 :]:
            yield left, right


def _block_pairs(key: str, block: list[_Org]) -> Iterable[tuple[_Org, _Org]]:
    """Pairs to compare within one first-token block, each as (lower id, higher id)."""
    if len(block) <= MAX_BLOCK_SIZE:
        return _all_pairs(block)
    log.info("block %r has %d orgs; sub-blocking", key, len(block))
    seen: set[tuple[int, int]] = set()
    out: list[tuple[_Org, _Org]] = []

    def add(a: _Org, b: _Org) -> None:
        left, right = (a, b) if a.id < b.id else (b, a)
        if (left.id, right.id) not in seen:
            seen.add((left.id, right.id))
            out.append((left, right))

    groups: dict[tuple[str, str], list[_Org]] = defaultdict(list)
    for org in block:  # block is in id order, so groups are too
        groups["token", org.tokens[1] if len(org.tokens) > 1 else ""].append(org)
        for name in org.names:
            groups["name", name].append(org)
    for group_key in sorted(groups):
        group = groups[group_key]
        if 1 < len(group) <= MAX_BLOCK_SIZE:
            for a, b in _all_pairs(group):
                add(a, b)
        elif len(group) > MAX_BLOCK_SIZE:
            log.warning(
                "sub-block %r/%r has %d orgs; comparing name-order neighbours only",
                key,
                group_key[1],
                len(group),
            )
    ordered = sorted(block, key=lambda o: (o.norm, o.id))
    for i, a in enumerate(ordered):
        for b in ordered[i + 1 : i + 1 + NEIGHBOR_WINDOW]:
            add(a, b)
    return out


def _score(left: _Org, right: _Org, threshold: float) -> tuple[float, dict] | None:
    """(score, signals) if the pair reaches `threshold`, else None."""
    prefix = _tokens_prefix(left.tokens, right.tokens)
    alias_overlap = bool(left.names & right.names)
    matcher = SequenceMatcher(None, left.norm, right.norm)
    if (
        not prefix
        and not alias_overlap
        # Cheap upper bounds on ratio(): skip the expensive call when they rule the pair out.
        # (Rounded like the score itself, so a pair exactly at the threshold survives.)
        and (
            round(matcher.real_quick_ratio(), 3) < threshold
            or round(matcher.quick_ratio(), 3) < threshold
        )
    ):
        return None
    sim = round(matcher.ratio(), 3)
    score = max(sim, 1.0 if alias_overlap else 0.0, PREFIX_SCORE if prefix else 0.0)
    if score < threshold:
        return None
    signals = {
        "name_similarity": sim,
        "name_prefix": prefix,
        "alias_overlap": alias_overlap,
        "different_ueis": bool(left.uei and right.uei and left.uei != right.uei),
    }
    return score, signals


def name_pairs(
    conn: psycopg.Connection, *, limit: int, threshold: float = NAME_THRESHOLD
) -> list[CandidatePair]:
    """Similar-name pairs for the agent: best score first, at most `limit`."""
    if limit <= 0:
        return []
    excluded = _excluded_pairs(conn)
    blocks: dict[str, list[_Org]] = defaultdict(list)
    for org in _live_companies(conn):
        if org.tokens:
            blocks[org.tokens[0]].append(org)

    scored: list[tuple[float, _Org, _Org, dict]] = []
    for key in sorted(blocks):
        for left, right in _block_pairs(key, blocks[key]):
            if (left.id, right.id) in excluded:
                continue
            if left.uei == right.uei and is_plausible_uei(left.uei):
                continue  # handled by uei_auto_merges
            hit = _score(left, right, threshold)
            if hit is not None:
                scored.append((hit[0], left, right, hit[1]))

    scored.sort(key=lambda s: (-s[0], s[1].id, s[2].id))
    scored = scored[:limit]
    if not scored:
        return []
    states, parents = _states(conn), _parents(conn)
    return [
        CandidatePair(
            left_org_id=left.id,
            right_org_id=right.id,
            left_name=left.name,
            right_name=right.name,
            left_uei=left.uei,
            right_uei=right.uei,
            signals={
                **signals,
                "same_state": _overlap(states.get(left.id), states.get(right.id)),
                "shared_parent": _overlap(parents.get(left.id), parents.get(right.id)),
            },
        )
        for _, left, right, signals in scored
    ]


def find(conn: psycopg.Connection, *, limit: int, threshold: float = NAME_THRESHOLD) -> Candidates:
    """Both outputs at once. The runner applies the auto-merges first and then
    calls name_pairs again, since merging changes which rows are live."""
    return Candidates(
        auto_merges=uei_auto_merges(conn),
        pairs=name_pairs(conn, limit=limit, threshold=threshold),
    )
