"""Signals: computed metrics over the award and solicitation stream.

One endpoint per signal, all under /api/signals. Every endpoint reads the
materialized views in migrations/007_signals.sql (where each metric's exact
definition lives, as SQL and comments) and returns the same envelope: `as_of`
(the day the views were last refreshed; every window ends on it), the window,
the category filter, the source tables the numbers came from, and `coverage`,
which says how far back the data goes, so a page can tell "no change" from "no
earlier data to compare with".

Nothing here estimates or fills in. A metric with no rows behind it returns an
empty list (or zeros with `coverage.prior_complete` false), never a placeholder.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.rows import dict_row
from pydantic import BaseModel

from pipeline import db
from pipeline.api.queries import taxonomy

WINDOWS = (7, 30, 90, 365)
# Growth from a prior period smaller than this is not ranked by percentage.
# Must match the threshold in signal_funding (migrations/007_signals.sql).
MIN_BASELINE = 100_000
# A topic needs at least this many solicitations in the prior period before its
# growth is given as a percentage.
MIN_TOPIC_BASELINE = 3
# Charts and sparklines: this many buckets across the prior and current period.
SERIES_BUCKETS = 12
STAGES = ["solicitation", "phase_1", "phase_2", "production"]

AWARD_TABLES = ["awards", "taggings", "tags", "organizations"]
OPP_TABLES = ["opportunities", "taggings", "tags", "organizations"]

# The plain-English definitions shown on the "About the numbers" page. Keep in
# step with migrations/007_signals.sql, which is what actually computes them.
DEFINITIONS: list[dict] = [
    {
        "key": "scope",
        "name": "What is counted",
        "text": (
            "Only awards and solicitations that the classifier tagged as autonomy-related. "
            "An award's date is the day it was signed; when the source gives no date, the day "
            "we fetched it. Dollar figures are obligated amounts as published by the source."
        ),
        "tables": ["awards", "opportunities", "taggings", "tags"],
    },
    {
        "key": "windows",
        "name": "Windows and the prior period",
        "text": (
            "A window of 30, 90 or 365 days is that many days ending on the as-of date, "
            "inclusive. The prior period is the same number of days immediately before it. "
            "The as-of date is the last nightly refresh. When our data does not reach back "
            "to the start of the prior period, changes are not shown."
        ),
        "tables": ["awards"],
    },
    {
        "key": "funding",
        "name": "Funding totals",
        "text": (
            "Dollars and award counts in the window, by company (the recipient), by agency "
            "(the awarding agency or office exactly as the source recorded it; offices are not "
            "rolled up into their parent) and by category. An award with two category tags "
            "counts once in each category, so categories can add up to more than the total."
        ),
        "tables": AWARD_TABLES,
    },
    {
        "key": "momentum",
        "name": "Momentum",
        "text": (
            "Award dollars in the window minus award dollars in the prior period, as a dollar "
            "change and as a percentage. The percentage is left blank, and the company is kept "
            f"out of percentage rankings, when the prior period is under ${MIN_BASELINE:,}: "
            "growth from almost nothing is noise."
        ),
        "tables": AWARD_TABLES,
    },
    {
        "key": "new_entrants",
        "name": "New entrants",
        "text": (
            "Companies whose earliest autonomy award in our data falls inside the window. Our "
            "data starts when the sources start, so a company can be new to this record without "
            "being new to the market."
        ),
        "tables": AWARD_TABLES,
    },
    {
        "key": "transitions",
        "name": "Transitions and stage reached",
        "text": (
            "Stages are solicitation, Phase I, Phase II and production. A company reaches "
            "'solicitation' when one of its awards is linked to a solicitation, and the other "
            'stages on its first award whose description names that stage ("Phase I", '
            '"Phase II", or production wording such as "production", "full-rate", '
            '"LRIP", "procure"). This is read from text: the sources publish no stage field. '
            "A transition is a company reaching a stage after an earlier one; the time between "
            "is counted from the first day at each stage. A company first seen at a late stage "
            "has reached it, but is not counted as a transition."
        ),
        "tables": ["awards", "opportunities", "taggings", "tags", "organizations"],
    },
    {
        "key": "topics",
        "name": "Topic heat",
        "text": (
            "Autonomy solicitations posted in the window against the prior period, by category "
            "tag. A topic is rising when it has more postings than in the prior period. The "
            f"percentage is shown only when the prior period had at least {MIN_TOPIC_BASELINE}. "
            "Solicitations come before money, so this is the leading indicator. It is empty "
            "until a solicitation source is loaded."
        ),
        "tables": OPP_TABLES,
    },
    {
        "key": "largest_awards",
        "name": "Largest awards",
        "text": "Single awards in the window, largest obligated amount first.",
        "tables": AWARD_TABLES,
    },
    {
        "key": "agencies",
        "name": "Agency appetite",
        "text": (
            "For each agency or office: award dollars and award count in the window, "
            "solicitations it posted in the window, and how its dollars split across categories."
        ),
        "tables": ["awards", "opportunities", "taggings", "tags", "organizations"],
    },
    {
        "key": "watchlist",
        "name": "Watchlist changes",
        "text": (
            "For each watched organization, awards and stages that first appeared in our data "
            "after your last visit, and its rank by 90-day dollars now against its rank on the "
            "day of that visit. The watchlist and the time of your last visit are kept in your "
            "browser only."
        ),
        "tables": AWARD_TABLES,
    },
]


# ---------------------------------------------------------------- models


class Org(BaseModel):
    id: int
    name: str
    kind: str
    tag: str | None = None  # the organization's largest category, for its medallion


class Coverage(BaseModel):
    first_award_day: date | None
    # False when our data starts after the prior period does: changes against
    # the prior period would compare a full window with a partial one. On the
    # topics endpoint, which counts only solicitations, this is judged from the
    # first solicitation on record instead of the first award.
    prior_complete: bool
    # The same test for solicitations, which can start on a different day than
    # awards (a solicitation source may be added long after the award sources).
    first_solicitation_day: date | None
    solicitations_prior_complete: bool


class Envelope(BaseModel):
    as_of: date
    refreshed_at: datetime
    window_days: int
    tag: str | None
    sample: bool
    sources: list[str]
    coverage: Coverage


class Page(Envelope):
    total: int
    limit: int
    offset: int


class Overview(Envelope):
    amount: float
    prev_amount: float
    awards: int
    prev_awards: int
    new_entrants: int
    prev_new_entrants: int
    open_solicitations: int
    prev_open_solicitations: int
    posted: int
    prev_posted: int


class FundingRow(BaseModel):
    org: Org | None
    category: str | None
    amount: float
    awards: int
    prev_amount: float
    prev_awards: int
    delta: float
    pct: float | None
    rank: int | None
    prev_rank: int | None
    pct_rank: int | None


class FundingPage(Page):
    by: str
    min_baseline: int
    items: list[FundingRow]


class EntrantRow(BaseModel):
    org: Org
    first_day: date
    first_amount: float
    amount: float
    awards: int
    tags: list[str]


class EntrantPage(Page):
    items: list[EntrantRow]


class StagePoint(BaseModel):
    stage: str
    day: date | None


class TransitionRow(BaseModel):
    org: Org
    from_stage: str | None
    to_stage: str
    from_day: date | None
    day: date
    days_between: int | None
    amount: float
    awards: int
    path: list[StagePoint]


class TransitionPage(Page):
    items: list[TransitionRow]


class TransitionCompanyRow(BaseModel):
    org: Org
    transitions: int  # stage-to-stage moves inside the window
    transitions_total: int  # and over all the data
    stage: str  # the furthest stage reached
    latest_day: date
    days_total: int | None  # first stage to furthest stage
    path: list[StagePoint]


class TransitionCompanyPage(Page):
    items: list[TransitionCompanyRow]


class TopicRow(BaseModel):
    category: str
    posted: int
    prev_posted: int
    delta: int
    pct: float | None
    open: int
    rising: bool
    amount: float  # award dollars in the same window, for context
    series: list[int]


class TopicPage(Page):
    bucket_days: float
    series_start: date
    items: list[TopicRow]


class AwardRow(BaseModel):
    id: int
    amount: float | None
    day: date
    description: str | None
    url: str | None
    stage: str | None
    tags: list[str]
    recipient: Org | None
    agency: Org | None


class AwardPage(Page):
    items: list[AwardRow]


class MixPart(BaseModel):
    category: str
    amount: float
    awards: int
    posted: int


class AgencyRow(BaseModel):
    org: Org
    amount: float
    awards: int
    prev_amount: float
    delta: float
    pct: float | None
    rank: int | None
    prev_rank: int | None
    posted: int
    prev_posted: int
    open: int
    mix: list[MixPart]


class AgencyPage(Page):
    items: list[AgencyRow]


class CategorySeriesRow(BaseModel):
    category: str
    amount: float
    awards: int
    prev_amount: float
    delta: float
    pct: float | None
    series: list[float]


class CategorySeries(Envelope):
    bucket_days: float
    series_start: date
    items: list[CategorySeriesRow]


class WatchAward(BaseModel):
    id: int
    amount: float | None
    day: date
    description: str | None
    stage: str | None


class WatchRow(BaseModel):
    org: Org
    new_awards: list[WatchAward]
    new_amount: float
    new_stages: list[StagePoint]
    rank: int | None
    rank_then: int | None
    last_award_day: date | None
    days_since_last: int | None


class Watchlist(Envelope):
    since: datetime | None
    items: list[WatchRow]


class OrgSignals(Envelope):
    org: Org
    amount: float
    prev_amount: float
    delta: float
    pct: float | None
    rank: int | None
    prev_rank: int | None
    category: str | None
    category_rank: int | None
    category_prev_rank: int | None
    stage: str | None
    stage_day: date | None
    path: list[StagePoint]
    first_day: date | None
    last_award_day: date | None
    days_since_last: int | None


class Definitions(BaseModel):
    as_of: date
    refreshed_at: datetime
    sample: bool
    first_award_day: date | None
    awards: int
    opportunities: int
    min_baseline: int
    min_topic_baseline: int
    items: list[dict]


# ---------------------------------------------------------------- plumbing


def get_conn():
    conn = db.connect()
    conn.read_only = True
    try:
        yield conn
    finally:
        conn.close()


Conn = Annotated[psycopg.Connection, Depends(get_conn)]
Window = Annotated[int, Query(description="Window in days: 7, 30, 90 or 365.")]
Tag = Annotated[str | None, Query(description="Category slug from /api/tags.")]
Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0)]
Order = Literal["asc", "desc"]

router = APIRouter(prefix="/api/signals", tags=["signals"])


def _rows(conn: psycopg.Connection, sql: str, **params) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def _f(v) -> float:
    return float(v) if v is not None else 0.0


def _check(window: int, tag: str | None) -> str:
    """Validate the common parameters; returns the slice ('' = all categories)."""
    if window not in WINDOWS:
        raise HTTPException(422, "window must be 7, 30, 90 or 365")
    if tag is not None and tag not in taxonomy()["tags"]:
        raise HTTPException(422, "unknown tag")
    return tag or ""


def _envelope(
    conn: psycopg.Connection,
    window: int,
    tag: str | None,
    sources: list[str],
    *,
    basis: Literal["awards", "solicitations"] = "awards",
) -> dict:
    """`basis` says which record `coverage.prior_complete` is judged from."""
    meta = _rows(conn, "SELECT * FROM signal_meta")[0]
    first = meta["first_award_day"]
    first_opp = _rows(conn, "SELECT min(day) AS d FROM signal_opportunities")[0]["d"]
    prior_starts = meta["as_of"] - timedelta(days=2 * window - 1)
    awards_ok = first is not None and first <= prior_starts
    opps_ok = first_opp is not None and first_opp <= prior_starts
    return {
        "as_of": meta["as_of"],
        "refreshed_at": meta["refreshed_at"],
        "window_days": window,
        "tag": tag,
        "sample": meta["sample"],
        "sources": sources,
        "coverage": {
            "first_award_day": first,
            "prior_complete": opps_ok if basis == "solicitations" else awards_ok,
            "first_solicitation_day": first_opp,
            "solicitations_prior_complete": opps_ok,
        },
    }


def _order_by(allowed: dict[str, str], sort: str, order: str) -> str:
    """The leading ORDER BY term for a `sort` / `order` pair. `sort` is looked
    up in a fixed table of SQL expressions and `order` is one of two words, so
    nothing the caller typed ever reaches the query text."""
    if sort not in allowed:
        raise HTTPException(422, f"sort must be one of {', '.join(allowed)}")
    return f"{allowed[sort]} {'ASC' if order == 'asc' else 'DESC'} NULLS LAST"


def _org(row: dict, prefix: str = "org_") -> dict | None:
    if row.get(f"{prefix}id") is None:
        return None
    return {
        "id": row[f"{prefix}id"],
        "name": row[f"{prefix}name"],
        "kind": row[f"{prefix}kind"],
        "tag": row.get(f"{prefix}tag"),
    }


def _path(points: list[dict] | None) -> list[dict]:
    reached = {p["stage"]: p["day"] for p in points or []}
    return [{"stage": s, "day": reached.get(s)} for s in STAGES]


PATH_SQL = """(
    SELECT json_agg(json_build_object('stage', s.stage, 'day', s.day) ORDER BY s.stage_order)
    FROM signal_stages s WHERE s.org_id = {org}
)"""


def _series(conn: psycopg.Connection, window: int, column: str) -> tuple[dict, date, float]:
    """`column` of signal_daily per category, in SERIES_BUCKETS equal buckets
    that span the prior and the current period. Returns ({slug: [values]},
    first day covered, days per bucket)."""
    rows = _rows(
        conn,
        f"""
        SELECT d.slice, ((d.day - (w.prev_after + 1)) * %(n)s / (2 * w.window_days)) AS bucket,
               sum(d.{column}) AS value, min(w.prev_after + 1) AS start
        FROM signal_daily d JOIN signal_windows w ON w.window_days = %(w)s
        WHERE d.slice <> '' AND d.day > w.prev_after AND d.day <= w.as_of
        GROUP BY d.slice, bucket
        """,
        w=window,
        n=SERIES_BUCKETS,
    )
    out: dict[str, list] = {}
    for r in rows:
        out.setdefault(r["slice"], [0] * SERIES_BUCKETS)[r["bucket"]] = r["value"]
    as_of = _rows(conn, "SELECT as_of FROM signal_meta")[0]["as_of"]
    start = as_of - timedelta(days=2 * window - 1)
    return out, start, 2 * window / SERIES_BUCKETS


# ---------------------------------------------------------------- endpoints


@router.get("/definitions")
def definitions(conn: Conn) -> Definitions:
    """What each number means, for the "About the numbers" page."""
    meta = _rows(conn, "SELECT * FROM signal_meta")[0]
    return Definitions(
        **{k: meta[k] for k in ("as_of", "refreshed_at", "sample", "first_award_day")},
        awards=meta["awards"],
        opportunities=meta["opportunities"],
        min_baseline=MIN_BASELINE,
        min_topic_baseline=MIN_TOPIC_BASELINE,
        items=DEFINITIONS,
    )


@router.get("/overview")
def overview(conn: Conn, window: Window = 90, tag: Tag = None) -> Overview:
    """The four headline figures, each with its prior-period value."""
    sl = _check(window, tag)
    env = _envelope(conn, window, tag, sorted({*AWARD_TABLES, *OPP_TABLES}))
    money = _rows(
        conn,
        """SELECT amount, awards, prev_amount, prev_awards FROM signal_funding
           WHERE window_days = %(w)s AND subject_type = 'total' AND slice = %(sl)s""",
        w=window,
        sl=sl,
    )
    opps = _rows(
        conn,
        """SELECT posted, prev_posted, open, prev_open FROM signal_solicitations
           WHERE window_days = %(w)s AND subject_type = 'total' AND slice = %(sl)s""",
        w=window,
        sl=sl,
    )
    entrants = _rows(
        conn,
        """SELECT count(*) FILTER (WHERE c.first_day > w.cur_after) AS cur,
                  count(*) FILTER (WHERE c.first_day <= w.cur_after) AS prev
           FROM signal_companies c JOIN signal_windows w ON w.window_days = %(w)s
           WHERE c.first_day > w.prev_after AND c.first_day <= w.as_of
             AND (%(sl)s = '' OR %(sl)s = ANY(c.tags))""",
        w=window,
        sl=sl,
    )[0]
    m = money[0] if money else {}
    o = opps[0] if opps else {}
    return Overview(
        **env,
        amount=_f(m.get("amount")),
        prev_amount=_f(m.get("prev_amount")),
        awards=m.get("awards", 0),
        prev_awards=m.get("prev_awards", 0),
        new_entrants=entrants["cur"],
        prev_new_entrants=entrants["prev"],
        open_solicitations=o.get("open", 0),
        prev_open_solicitations=o.get("prev_open", 0),
        posted=o.get("posted", 0),
        prev_posted=o.get("prev_posted", 0),
    )


FUNDING_SORT = {
    "amount": "f.amount",
    "awards": "f.awards",
    "delta": "f.delta",
    "pct": "f.pct",
    "prev_amount": "f.prev_amount",
    "name": "name",
}


def _funding(
    conn: psycopg.Connection,
    *,
    by: str,
    window: int,
    tag: str | None,
    sort: str,
    order: str,
    where: str,
    limit: int,
    offset: int,
) -> FundingPage:
    sl = _check(window, tag)
    by_sort = _order_by(FUNDING_SORT, sort, order)
    if by == "category":
        # Categories are the 'total' rows that carry a slice; `tag` does not apply.
        scope = "f.subject_type = 'total' AND f.slice <> ''"
        tag = None
    else:
        scope = "f.subject_type = %(by)s AND f.slice = %(sl)s"
    base = f"""
        FROM signal_funding f
        LEFT JOIN organizations o ON o.id = f.org_id
        LEFT JOIN signal_companies c ON c.org_id = f.org_id
        WHERE f.window_days = %(w)s AND {scope} AND {where}
    """
    params = {"w": window, "by": by, "sl": sl, "floor": MIN_BASELINE}
    total = _rows(conn, f"SELECT count(*) AS n {base}", **params)[0]["n"]
    rows = _rows(
        conn,
        f"""
        SELECT f.*, o.id AS org_id, COALESCE(o.canonical_name, f.slice) AS name,
               o.canonical_name AS org_name, o.kind AS org_kind, c.tags[1] AS org_tag
        {base}
        ORDER BY {by_sort}, f.amount DESC, f.org_id, f.slice
        LIMIT %(limit)s OFFSET %(offset)s
        """,
        **params,
        limit=limit,
        offset=offset,
    )
    items = [
        FundingRow(
            org=_org(r),
            category=r["slice"] if by == "category" else None,
            amount=_f(r["amount"]),
            awards=r["awards"],
            prev_amount=_f(r["prev_amount"]),
            prev_awards=r["prev_awards"],
            delta=_f(r["delta"]),
            pct=float(r["pct"]) if r["pct"] is not None else None,
            rank=r["rank"],
            prev_rank=r["prev_rank"],
            pct_rank=r["pct_rank"],
        )
        for r in rows
    ]
    return FundingPage(
        **_envelope(conn, window, tag, AWARD_TABLES),
        total=total,
        limit=limit,
        offset=offset,
        by=by,
        min_baseline=MIN_BASELINE,
        items=items,
    )


@router.get("/funding")
def funding(
    conn: Conn,
    by: Literal["company", "agency", "category"] = "company",
    window: Window = 90,
    tag: Tag = None,
    sort: str = "amount",
    order: Order = "desc",
    limit: Limit = 25,
    offset: Offset = 0,
) -> FundingPage:
    """Signal 1: dollars and awards in the window, by company, agency or category."""
    return _funding(
        conn,
        by=by,
        window=window,
        tag=tag,
        sort=sort,
        order=order,
        where="f.awards > 0",
        limit=limit,
        offset=offset,
    )


@router.get("/momentum")
def momentum(
    conn: Conn,
    by: Literal["company", "category"] = "company",
    window: Window = 90,
    tag: Tag = None,
    sort: Literal["pct", "delta"] = "pct",
    direction: Literal["rising", "falling", "all"] = "rising",
    order: Annotated[
        Order | None, Query(description="Default: biggest move first for the direction.")
    ] = None,
    limit: Limit = 25,
    offset: Offset = 0,
) -> FundingPage:
    """Signal 2: change against the prior period. Sorting by `pct` leaves out
    anything whose prior period is under `min_baseline` dollars. Without
    `order` the biggest move comes first: the largest rise, or for
    `direction=falling` the largest fall."""
    where = {"rising": "f.delta > 0", "falling": "f.delta < 0", "all": "true"}[direction]
    if sort == "pct":
        where += " AND f.pct IS NOT NULL"
    return _funding(
        conn,
        by=by,
        window=window,
        tag=tag,
        sort=sort,
        order=order or ("asc" if direction == "falling" else "desc"),
        where=where,
        limit=limit,
        offset=offset,
    )


ENTRANT_SORT = {
    "amount": "c.amount",
    "first_day": "c.first_day",
    "first_amount": "c.first_amount",
    "awards": "c.awards",
    "name": "o.canonical_name",
}


@router.get("/new-entrants")
def new_entrants(
    conn: Conn,
    window: Window = 90,
    tag: Tag = None,
    sort: str = "amount",
    order: Order = "desc",
    limit: Limit = 25,
    offset: Offset = 0,
) -> EntrantPage:
    """Signal 3: companies whose first autonomy award in our data is in the window."""
    sl = _check(window, tag)
    by = _order_by(ENTRANT_SORT, sort, order)
    base = """
        FROM signal_companies c
        JOIN signal_windows w ON w.window_days = %(w)s
        JOIN organizations o ON o.id = c.org_id
        WHERE c.first_day > w.cur_after AND c.first_day <= w.as_of
          AND (%(sl)s = '' OR %(sl)s = ANY(c.tags))
    """
    total = _rows(conn, f"SELECT count(*) AS n {base}", w=window, sl=sl)[0]["n"]
    rows = _rows(
        conn,
        f"""SELECT c.*, o.id AS org_id, o.canonical_name AS org_name, o.kind AS org_kind,
                   c.tags[1] AS org_tag
            {base} ORDER BY {by}, c.amount DESC, c.org_id LIMIT %(limit)s OFFSET %(offset)s""",
        w=window,
        sl=sl,
        limit=limit,
        offset=offset,
    )
    return EntrantPage(
        **_envelope(conn, window, tag, AWARD_TABLES),
        total=total,
        limit=limit,
        offset=offset,
        items=[
            EntrantRow(
                org=_org(r),
                first_day=r["first_day"],
                first_amount=_f(r["first_amount"]),
                amount=_f(r["amount"]),
                awards=r["awards"],
                tags=r["tags"],
            )
            for r in rows
        ],
    )


TRANSITION_TABLES = ["awards", "opportunities", "taggings", "tags", "organizations"]


@router.get("/transitions")
def transitions(
    conn: Conn,
    window: Window = 90,
    tag: Tag = None,
    stage: Literal["any", "phase_1", "phase_2", "production"] = "any",
    entries: Annotated[
        bool, Query(description="Also list companies first seen at this stage.")
    ] = False,
    limit: Limit = 25,
    offset: Offset = 0,
) -> TransitionPage:
    """Signal 4: companies that reached a stage inside the window, newest first."""
    sl = _check(window, tag)
    base = """
        FROM signal_transitions t
        JOIN signal_windows w ON w.window_days = %(w)s
        JOIN organizations o ON o.id = t.org_id
        LEFT JOIN signal_companies c ON c.org_id = t.org_id
        WHERE t.stage_order >= 1 AND t.day > w.cur_after AND t.day <= w.as_of
          AND (%(stage)s = 'any' OR t.to_stage = %(stage)s)
          AND (%(entries)s OR t.from_stage IS NOT NULL)
          AND (%(sl)s = '' OR %(sl)s = ANY(c.tags))
    """
    params = {"w": window, "sl": sl, "stage": stage, "entries": entries}
    total = _rows(conn, f"SELECT count(*) AS n {base}", **params)[0]["n"]
    rows = _rows(
        conn,
        f"""SELECT t.*, o.id AS org_id, o.canonical_name AS org_name, o.kind AS org_kind,
                   c.tags[1] AS org_tag, {PATH_SQL.format(org="t.org_id")} AS path
            {base}
            ORDER BY t.day DESC, t.stage_order DESC, t.amount DESC, t.org_id
            LIMIT %(limit)s OFFSET %(offset)s""",
        **params,
        limit=limit,
        offset=offset,
    )
    return TransitionPage(
        **_envelope(conn, window, tag, TRANSITION_TABLES),
        total=total,
        limit=limit,
        offset=offset,
        items=[
            TransitionRow(
                org=_org(r),
                from_stage=r["from_stage"],
                to_stage=r["to_stage"],
                from_day=r["from_day"],
                day=r["day"],
                days_between=r["days_between"],
                amount=_f(r["amount"]),
                awards=r["n"],
                path=_path(r["path"]),
            )
            for r in rows
        ],
    )


TRANSITION_COMPANY_SORT = {
    "transitions": "x.transitions",
    "transitions_total": "x.transitions_total",
    "stage": "x.top",
    "latest_day": "x.latest_day",
    "days_total": "x.days_total",
    "name": "o.canonical_name",
}


@router.get("/transitions/companies")
def transition_companies(
    conn: Conn,
    window: Window = 90,
    tag: Tag = None,
    sort: str = "transitions",
    order: Order = "desc",
    limit: Limit = 25,
    offset: Offset = 0,
) -> TransitionCompanyPage:
    """Signal 4 as a ranking: companies by stage-to-stage moves inside the window."""
    sl = _check(window, tag)
    by = _order_by(TRANSITION_COMPANY_SORT, sort, order)
    base = """
        FROM (
            SELECT t.org_id,
                   count(*) FILTER (
                       WHERE t.from_stage IS NOT NULL AND t.day > w.cur_after AND t.day <= w.as_of
                   ) AS transitions,
                   count(*) FILTER (WHERE t.from_stage IS NOT NULL) AS transitions_total,
                   max(t.stage_order) AS top, max(t.day) AS latest_day,
                   -- first stage on record to the furthest one (not to the latest
                   -- date: a linked solicitation can be posted after production)
                   (array_agg(t.day ORDER BY t.stage_order DESC))[1]
                       - min(COALESCE(t.from_day, t.day)) AS days_total
            FROM signal_transitions t JOIN signal_windows w ON w.window_days = %(w)s
            GROUP BY t.org_id
        ) x
        JOIN organizations o ON o.id = x.org_id
        LEFT JOIN signal_companies c ON c.org_id = x.org_id
        WHERE x.transitions > 0 AND (%(sl)s = '' OR %(sl)s = ANY(c.tags))
    """
    total = _rows(conn, f"SELECT count(*) AS n {base}", w=window, sl=sl)[0]["n"]
    rows = _rows(
        conn,
        f"""SELECT x.*, o.id AS org_id, o.canonical_name AS org_name, o.kind AS org_kind,
                   c.tags[1] AS org_tag, {PATH_SQL.format(org="x.org_id")} AS path
            {base}
            ORDER BY {by}, x.transitions DESC, x.transitions_total DESC, x.top DESC,
                     x.latest_day DESC, x.org_id
            LIMIT %(limit)s OFFSET %(offset)s""",
        w=window,
        sl=sl,
        limit=limit,
        offset=offset,
    )
    return TransitionCompanyPage(
        **_envelope(conn, window, tag, TRANSITION_TABLES),
        total=total,
        limit=limit,
        offset=offset,
        items=[
            TransitionCompanyRow(
                org=_org(r),
                transitions=r["transitions"],
                transitions_total=r["transitions_total"],
                stage=STAGES[r["top"]],
                latest_day=r["latest_day"],
                days_total=r["days_total"],
                path=_path(r["path"]),
            )
            for r in rows
        ],
    )


TOPIC_SORT = {
    "delta": "s.posted - s.prev_posted",
    "posted": "s.posted",
    "prev_posted": "s.prev_posted",
    "open": "s.open",
    "amount": "COALESCE(f.amount, 0)",
    "category": "s.slice",
}


@router.get("/topics")
def topics(
    conn: Conn,
    window: Window = 90,
    sort: str = "delta",
    order: Order = "desc",
    limit: Limit = 25,
    offset: Offset = 0,
) -> TopicPage:
    """Signal 5: solicitations posted per category, this period against the last.
    Rising topics first. Demand shows up here before it shows up as awards."""
    _check(window, None)
    by = _order_by(TOPIC_SORT, sort, order)
    rows = _rows(
        conn,
        f"""
        SELECT s.slice, s.posted, s.prev_posted, s.open, COALESCE(f.amount, 0) AS amount
        FROM signal_solicitations s
        LEFT JOIN signal_funding f
          ON f.window_days = s.window_days AND f.subject_type = 'total' AND f.slice = s.slice
        WHERE s.window_days = %(w)s AND s.subject_type = 'total' AND s.slice <> ''
          AND s.posted + s.prev_posted > 0
        ORDER BY {by}, s.posted - s.prev_posted DESC, s.posted DESC, s.slice
        """,
        w=window,
    )
    series, start, bucket_days = _series(conn, window, "posted")
    items = [
        TopicRow(
            category=r["slice"],
            posted=r["posted"],
            prev_posted=r["prev_posted"],
            delta=r["posted"] - r["prev_posted"],
            pct=(
                (r["posted"] - r["prev_posted"]) / r["prev_posted"]
                if r["prev_posted"] >= MIN_TOPIC_BASELINE
                else None
            ),
            open=r["open"],
            rising=r["posted"] > r["prev_posted"],
            amount=_f(r["amount"]),
            series=[int(v) for v in series.get(r["slice"], [0] * SERIES_BUCKETS)],
        )
        for r in rows
    ]
    return TopicPage(
        **_envelope(conn, window, None, OPP_TABLES, basis="solicitations"),
        total=len(items),
        limit=limit,
        offset=offset,
        bucket_days=bucket_days,
        series_start=start,
        items=items[offset : offset + limit],
    )


@router.get("/largest-awards")
def largest_awards(
    conn: Conn, window: Window = 90, tag: Tag = None, limit: Limit = 10, offset: Offset = 0
) -> AwardPage:
    """Signal 6: the biggest single awards in the window."""
    sl = _check(window, tag)
    base = """
        FROM signal_awards a
        JOIN signal_windows w ON w.window_days = %(w)s
        LEFT JOIN organizations r ON r.id = a.recipient_id
        LEFT JOIN signal_companies c ON c.org_id = a.recipient_id
        LEFT JOIN organizations g ON g.id = a.agency_id
        WHERE a.day > w.cur_after AND a.day <= w.as_of AND a.amount IS NOT NULL
          AND (%(sl)s = '' OR %(sl)s = ANY(a.tags))
    """
    total = _rows(conn, f"SELECT count(*) AS n {base}", w=window, sl=sl)[0]["n"]
    rows = _rows(
        conn,
        f"""SELECT a.id, a.amount, a.day, a.description, a.url, a.stage, a.tags,
                   r.id AS r_id, r.canonical_name AS r_name, r.kind AS r_kind, c.tags[1] AS r_tag,
                   g.id AS g_id, g.canonical_name AS g_name, g.kind AS g_kind
            {base} ORDER BY a.amount DESC, a.day DESC, a.id
            LIMIT %(limit)s OFFSET %(offset)s""",
        w=window,
        sl=sl,
        limit=limit,
        offset=offset,
    )
    return AwardPage(
        **_envelope(conn, window, tag, AWARD_TABLES),
        total=total,
        limit=limit,
        offset=offset,
        items=[
            AwardRow(
                id=r["id"],
                amount=float(r["amount"]),
                day=r["day"],
                description=r["description"],
                url=r["url"],
                stage=r["stage"],
                tags=r["tags"],
                recipient=_org(r, "r_"),
                agency=_org(r, "g_"),
            )
            for r in rows
        ],
    )


# An agency that only posted solicitations has no funding row, and one that only
# awarded has no solicitation row: a missing side counts as zero.
AGENCY_SORT = {
    "amount": "COALESCE(f.amount, 0)",
    "awards": "COALESCE(f.awards, 0)",
    "posted": "COALESCE(s.posted, 0)",
    "delta": "COALESCE(f.delta, 0)",
    "name": "o.canonical_name",
}


@router.get("/agencies")
def agencies(
    conn: Conn,
    window: Window = 90,
    tag: Tag = None,
    sort: str = "amount",
    order: Order = "desc",
    limit: Limit = 25,
    offset: Offset = 0,
) -> AgencyPage:
    """Signal 7: which agencies and offices are buying and asking, and for what."""
    sl = _check(window, tag)
    by = _order_by(AGENCY_SORT, sort, order)
    # An agency belongs here if it awarded or posted anything in the window.
    base = """
        FROM (
            SELECT org_id FROM signal_funding
            WHERE window_days = %(w)s AND subject_type = 'agency' AND slice = %(sl)s AND awards > 0
            UNION
            SELECT org_id FROM signal_solicitations
            WHERE window_days = %(w)s AND subject_type = 'agency' AND slice = %(sl)s AND posted > 0
        ) k
        JOIN organizations o ON o.id = k.org_id
        LEFT JOIN signal_funding f
          ON f.window_days = %(w)s AND f.subject_type = 'agency' AND f.slice = %(sl)s
         AND f.org_id = k.org_id
        LEFT JOIN signal_solicitations s
          ON s.window_days = %(w)s AND s.subject_type = 'agency' AND s.slice = %(sl)s
         AND s.org_id = k.org_id
    """
    total = _rows(conn, f"SELECT count(*) AS n {base}", w=window, sl=sl)[0]["n"]
    rows = _rows(
        conn,
        f"""SELECT o.id AS org_id, o.canonical_name AS org_name, o.kind AS org_kind,
                   f.amount, f.awards, f.prev_amount, f.delta, f.pct, f.rank, f.prev_rank,
                   s.posted, s.prev_posted, s.open
            {base} ORDER BY {by}, COALESCE(f.amount, 0) DESC, o.id
            LIMIT %(limit)s OFFSET %(offset)s""",
        w=window,
        sl=sl,
        limit=limit,
        offset=offset,
    )
    ids = [r["org_id"] for r in rows]
    mix: dict[int, dict[str, dict]] = {i: {} for i in ids}
    for m in _rows(
        conn,
        """SELECT org_id, slice, amount, awards FROM signal_funding
           WHERE window_days = %(w)s AND subject_type = 'agency' AND slice <> ''
             AND org_id = ANY(%(ids)s) AND awards > 0""",
        w=window,
        ids=ids,
    ):
        mix[m["org_id"]][m["slice"]] = {
            "category": m["slice"],
            "amount": _f(m["amount"]),
            "awards": m["awards"],
            "posted": 0,
        }
    for m in _rows(
        conn,
        """SELECT org_id, slice, posted FROM signal_solicitations
           WHERE window_days = %(w)s AND subject_type = 'agency' AND slice <> ''
             AND org_id = ANY(%(ids)s) AND posted > 0""",
        w=window,
        ids=ids,
    ):
        part = mix[m["org_id"]].setdefault(
            m["slice"], {"category": m["slice"], "amount": 0.0, "awards": 0, "posted": 0}
        )
        part["posted"] = m["posted"]
    return AgencyPage(
        **_envelope(conn, window, tag, TRANSITION_TABLES),
        total=total,
        limit=limit,
        offset=offset,
        items=[
            AgencyRow(
                org=_org(r),
                amount=_f(r["amount"]),
                awards=r["awards"] or 0,
                prev_amount=_f(r["prev_amount"]),
                delta=_f(r["delta"]),
                pct=float(r["pct"]) if r["pct"] is not None else None,
                rank=r["rank"],
                prev_rank=r["prev_rank"],
                posted=r["posted"] or 0,
                prev_posted=r["prev_posted"] or 0,
                open=r["open"] or 0,
                mix=sorted(
                    mix[r["org_id"]].values(),
                    key=lambda p: (p["amount"], p["posted"]),
                    reverse=True,
                ),
            )
            for r in rows
        ],
    )


@router.get("/categories/series")
def category_series(conn: Conn, window: Window = 90) -> CategorySeries:
    """Signal 1 over time: award dollars per category in equal buckets across
    the prior and current period, largest category first."""
    _check(window, None)
    series, start, bucket_days = _series(conn, window, "amount")
    rows = _rows(
        conn,
        """SELECT slice, amount, awards, prev_amount, delta, pct FROM signal_funding
           WHERE window_days = %(w)s AND subject_type = 'total' AND slice <> ''
           ORDER BY amount DESC, slice""",
        w=window,
    )
    return CategorySeries(
        **_envelope(conn, window, None, AWARD_TABLES),
        bucket_days=bucket_days,
        series_start=start,
        items=[
            CategorySeriesRow(
                category=r["slice"],
                amount=_f(r["amount"]),
                awards=r["awards"],
                prev_amount=_f(r["prev_amount"]),
                delta=_f(r["delta"]),
                pct=float(r["pct"]) if r["pct"] is not None else None,
                series=[float(v) for v in series.get(r["slice"], [0] * SERIES_BUCKETS)],
            )
            for r in rows
        ],
    )


def _org_row(conn: psycopg.Connection, org_id: int) -> dict | None:
    """The live organization row, following merges."""
    for _ in range(20):
        rows = _rows(
            conn,
            """SELECT o.id AS org_id, o.canonical_name AS org_name, o.kind AS org_kind,
                      o.merged_into, c.tags[1] AS org_tag, c.first_day, c.last_day
               FROM organizations o LEFT JOIN signal_companies c ON c.org_id = o.id
               WHERE o.id = %(id)s""",
            id=org_id,
        )
        if not rows:
            return None
        if rows[0]["merged_into"] is None:
            return rows[0]
        org_id = rows[0]["merged_into"]
    return None


@router.get("/watchlist")
def watchlist(
    conn: Conn,
    ids: Annotated[str, Query(description="Comma-separated organization ids.", max_length=200)],
    since: Annotated[
        datetime | None, Query(description="The reader's last visit (ISO 8601).")
    ] = None,
) -> Watchlist:
    """Signal 8: for each watched organization, what is new since `since`: awards
    and stages that first appeared in our data after it, and rank by 90-day
    dollars now against rank on that day. Without `since` nothing is new."""
    try:
        wanted = [int(x) for x in ids.split(",") if x.strip()][:20]
    except ValueError:
        raise HTTPException(422, "ids must be integers") from None
    env = _envelope(conn, 90, None, AWARD_TABLES)
    as_of = env["as_of"]
    then: dict[int, int] = {}
    if since is not None:
        # Rank as the site would have shown it on the day of the last visit:
        # trailing 90 days ending that day, over awards we had by then.
        then = {
            r["recipient_id"]: r["rank"]
            for r in _rows(
                conn,
                """SELECT recipient_id, rank() OVER (ORDER BY sum(amount) DESC) AS rank
                   FROM signal_awards
                   WHERE first_seen_at <= %(since)s AND recipient_id IS NOT NULL
                     AND day > %(since)s::date - 90 AND day <= %(since)s::date
                   GROUP BY recipient_id""",
                since=since,
            )
        }
    items = []
    seen: set[int] = set()
    for wanted_id in wanted:
        row = _org_row(conn, wanted_id)
        if row is None or row["org_id"] in seen:
            continue
        seen.add(row["org_id"])
        oid = row["org_id"]
        col = "recipient_id" if row["org_kind"] == "company" else "agency_id"
        new_awards = (
            _rows(
                conn,
                f"""SELECT id, amount, day, description, stage FROM signal_awards
                    WHERE {col} = %(id)s AND first_seen_at > %(since)s
                    ORDER BY day DESC, id DESC LIMIT 20""",
                id=oid,
                since=since,
            )
            if since is not None
            else []
        )
        new_stages = (
            _rows(
                conn,
                """SELECT stage, day FROM signal_stages
                   WHERE org_id = %(id)s AND stage_order >= 1 AND first_seen_at > %(since)s
                   ORDER BY stage_order""",
                id=oid,
                since=since,
            )
            if since is not None
            else []
        )
        rank = _rows(
            conn,
            """SELECT rank FROM signal_funding
               WHERE window_days = 90 AND slice = '' AND org_id = %(id)s
                 AND subject_type = %(st)s""",
            id=oid,
            st="company" if row["org_kind"] == "company" else "agency",
        )
        last = row["last_day"]
        if row["org_kind"] != "company":
            got = _rows(
                conn, "SELECT max(day) AS d FROM signal_awards WHERE agency_id = %(id)s", id=oid
            )
            last = got[0]["d"]
        items.append(
            WatchRow(
                org=_org(row),
                new_awards=[
                    WatchAward(**{**a, "amount": float(a["amount"]) if a["amount"] else None})
                    for a in new_awards
                ],
                new_amount=sum(_f(a["amount"]) for a in new_awards),
                new_stages=[StagePoint(**s) for s in new_stages],
                rank=rank[0]["rank"] if rank else None,
                # Only companies are ranked "then"; agencies have no stored history.
                rank_then=then.get(oid) if row["org_kind"] == "company" else None,
                last_award_day=last,
                days_since_last=(as_of - last).days if last else None,
            )
        )
    return Watchlist(**env, since=since, items=items)


@router.get("/orgs/{org_id}")
def org_signals(conn: Conn, org_id: int) -> OrgSignals:
    """The entity page's signals: 90-day momentum, rank overall and in its
    largest category, stage reached, and time since the last award."""
    row = _org_row(conn, org_id)
    if row is None:
        raise HTTPException(404, "organization not found")
    oid = row["org_id"]
    company = row["org_kind"] == "company"
    env = _envelope(conn, 90, None, TRANSITION_TABLES if company else AWARD_TABLES)
    fund = {
        r["slice"]: r
        for r in _rows(
            conn,
            """SELECT slice, amount, prev_amount, delta, pct, rank, prev_rank FROM signal_funding
               WHERE window_days = 90 AND subject_type = %(st)s AND org_id = %(id)s""",
            st="company" if company else "agency",
            id=oid,
        )
    }
    overall = fund.get("", {})
    category = row["org_tag"]
    in_cat = fund.get(category or "\0", {})
    stages = (
        _rows(
            conn,
            "SELECT stage, day, stage_order FROM signal_stages WHERE org_id = %(id)s"
            " ORDER BY stage_order",
            id=oid,
        )
        if company
        else []
    )
    top = stages[-1] if stages else None
    last = row["last_day"]
    if not company:
        got = _rows(
            conn, "SELECT max(day) AS d FROM signal_awards WHERE agency_id = %(id)s", id=oid
        )
        last = got[0]["d"]
    return OrgSignals(
        **env,
        org=_org(row),
        amount=_f(overall.get("amount")),
        prev_amount=_f(overall.get("prev_amount")),
        delta=_f(overall.get("delta")),
        pct=float(overall["pct"]) if overall.get("pct") is not None else None,
        rank=overall.get("rank"),
        prev_rank=overall.get("prev_rank"),
        category=category,
        category_rank=in_cat.get("rank"),
        category_prev_rank=in_cat.get("prev_rank"),
        stage=top["stage"] if top else None,
        stage_day=top["day"] if top else None,
        path=_path(stages),
        first_day=row["first_day"],
        last_award_day=last,
        days_since_last=(env["as_of"] - last).days if last else None,
    )
