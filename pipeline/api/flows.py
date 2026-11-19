"""The explorer's one query: who paid whom, for what, in a window.

    GET /api/flows?window=90d

It answers with everything the landing page and the three tool views draw:

    window         the window served (key, start, end, latest_data_date, label)
    windows        every window with its award count, so the site can tell
                   which are empty without asking
    agencies       paying agencies and offices, with their dollars
    missions       the taxonomy's categories, always all of them, in file order
    companies      recipients, with their dollars and first award on record
    flows          agency -> mission, mission -> company and agency -> company
                   bands, each with its dollars and the ids of its awards
    awards         the award records those ids name, each with its source link
    max_award_id   the highest award id on record (in any window): what a
                   returning reader compares against to see what is new
    solicitations  solicitations posted in the window or answered by one of
                   its awards

An award tagged with several missions splits its dollars evenly between them
in the two mission flows, so every column of the flow adds up to the same
total (the agency -> company flow carries the whole amount). An award whose
only tag is the root goes to the pseudo-mission "other".

The window comes from pipeline/api/windows.py and nowhere else.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import psycopg

from pipeline.api import windows
from pipeline.api.names import display_name
from pipeline.api.queries import AWARDS_CTE, OPP_TAGS, _money, _rows, taxonomy

OTHER = "other"  # the mission of an award with no category tag
NO_AGENCY = "org:0"  # an award whose paying agency was not recorded


def _today() -> date:
    return datetime.now(UTC).date()


def latest_and_days(conn: psycopg.Connection) -> tuple[date | None, dict[date, int], bool]:
    """The newest award's day, the number of awards on each day, and whether
    the database holds the synthetic seed rows."""
    rows = _rows(
        conn,
        AWARDS_CTE
        + "SELECT aa.day, count(*) AS n FROM aa WHERE aa.recipient_id IS NOT NULL GROUP BY aa.day",
    )
    days = {r["day"]: r["n"] for r in rows}
    sample = bool(
        _rows(conn, "SELECT EXISTS (SELECT 1 FROM awards WHERE source = 'seed') AS s")[0]["s"]
    )
    return (max(days) if days else None), days, sample


def flows(
    conn: psycopg.Connection, window: str | None = None, *, today: date | None = None
) -> dict:
    """See the module docstring. `window` is a key from windows.KEYS (or
    "recent"); None picks the default, the first window with an award in it.
    Raises KeyError for an unknown key."""
    today = today or _today()
    latest, per_day, sample = latest_and_days(conn)
    counts = windows.count_by_window(per_day, latest)
    chosen = window is None
    key = windows.default_key(counts) if chosen else windows.canonical(window)
    if key is None:
        raise KeyError(window)
    w = windows.resolve(key, latest, today=today)

    awards = _rows(
        conn,
        AWARDS_CTE
        + """
        SELECT aa.id, aa.day, aa.amount, aa.recipient_id, aa.agency_id, aa.opportunity_id,
               aa.tags, aa.url, aa.source, aa.source_id, left(aa.description, 180) AS description
        FROM aa
        WHERE aa.recipient_id IS NOT NULL
          AND (%(start)s::date IS NULL OR aa.day >= %(start)s::date)
          AND (%(end)s::date IS NULL OR aa.day <= %(end)s::date)
        ORDER BY aa.day, aa.id
        """,
        start=w.start,
        end=w.end,
    )

    slugs = list(taxonomy()["tags"])
    missions = {
        s: {"id": f"tag:{s}", "slug": s, "dollars": 0.0, "awards": 0, "companies": set()}
        for s in slugs
    }
    agencies: dict[str, dict] = {}
    companies: dict[str, dict] = {}
    bands: dict[tuple[str, str, str], dict] = {}

    def party(table: dict[str, dict], key: str) -> dict:
        return table.setdefault(key, {"id": key, "dollars": 0.0, "awards": 0})

    def band(kind: str, source: str, target: str, dollars: float, award_id: int) -> None:
        b = bands.setdefault(
            (kind, source, target),
            {"kind": kind, "source": source, "target": target, "dollars": 0.0, "award_ids": []},
        )
        b["dollars"] += dollars
        b["award_ids"].append(award_id)

    out_awards = []
    opp_awards: dict[int, list[int]] = {}
    for a in awards:
        amount = _money(a["amount"])
        tags = [t for t in a["tags"] if t in missions] or [OTHER]
        if OTHER in tags and OTHER not in missions:
            missions[OTHER] = {
                "id": f"tag:{OTHER}",
                "slug": OTHER,
                "dollars": 0.0,
                "awards": 0,
                "companies": set(),
            }
        co = f"org:{a['recipient_id']}"
        ag = f"org:{a['agency_id']}" if a["agency_id"] else NO_AGENCY
        c = party(companies, co)
        c["dollars"] += amount
        c["awards"] += 1
        mt = c.setdefault("mission_dollars", {})
        g = party(agencies, ag)
        g["dollars"] += amount
        g["awards"] += 1
        share = amount / len(tags)
        for t in tags:
            m = missions[t]
            m["dollars"] += share
            m["awards"] += 1
            m["companies"].add(co)
            mt[t] = mt.get(t, 0.0) + share
            band("agency-mission", ag, m["id"], share, a["id"])
            band("mission-company", m["id"], co, share, a["id"])
        band("agency-company", ag, co, amount, a["id"])
        if a["opportunity_id"]:
            opp_awards.setdefault(a["opportunity_id"], []).append(a["id"])
        out_awards.append(
            {
                "id": a["id"],
                "day": a["day"],
                "amount": float(a["amount"]) if a["amount"] is not None else None,
                "agency": ag,
                "company": co,
                "missions": tags,
                "url": a["url"],
                "source": a["source"],
                "source_id": a["source_id"],
                "description": a["description"],
                "opportunity": f"opp:{a['opportunity_id']}" if a["opportunity_id"] else None,
            }
        )

    # Solicitations posted in the window, plus any one of its awards answered.
    solicitations = []
    for o in _rows(
        conn,
        f"""
        SELECT o.id, o.title, o.agency_id, o.url,
               COALESCE(o.posted_at, o.fetched_at)::date AS posted,
               o.closes_at::date AS closes, {OPP_TAGS} AS tags,
               (o.closes_at IS NULL OR o.closes_at > now()) AS open,
               (SELECT min(COALESCE(a.signed_at, a.fetched_at::date)) FROM awards a
                 WHERE a.opportunity_id = o.id) AS awarded_on
        FROM opportunities o
        WHERE o.id = ANY(%(ids)s)
           OR ((%(start)s::date IS NULL
                OR COALESCE(o.posted_at, o.fetched_at)::date >= %(start)s::date)
               AND (%(end)s::date IS NULL
                OR COALESCE(o.posted_at, o.fetched_at)::date <= %(end)s::date))
        ORDER BY posted, o.id
        """,
        ids=list(opp_awards),
        start=w.start,
        end=w.end,
    ):
        ag = f"org:{o['agency_id']}" if o["agency_id"] else NO_AGENCY
        party(agencies, ag)
        solicitations.append(
            {
                "id": f"opp:{o['id']}",
                "title": o["title"],
                "agency": ag,
                "missions": [t for t in o["tags"] if t in missions],
                "posted": o["posted"],
                "closes": o["closes"],
                "open": o["open"],
                "awarded_on": o["awarded_on"],
                "url": o["url"],
                "award_ids": opp_awards.get(o["id"], []),
            }
        )

    org_ids = [int(k.split(":")[1]) for k in (*agencies, *companies) if k != NO_AGENCY]
    names = {
        f"org:{o['id']}": o
        for o in _rows(
            conn,
            "SELECT id, canonical_name, kind, uei FROM organizations WHERE id = ANY(%(ids)s)",
            ids=org_ids,
        )
    }
    seen = {
        f"org:{r['recipient_id']}": r
        for r in _rows(
            conn,
            AWARDS_CTE
            + "SELECT aa.recipient_id, min(aa.day) AS first_day, min(aa.id) AS first_id FROM aa"
            + " WHERE aa.recipient_id = ANY(%(ids)s) GROUP BY aa.recipient_id",
            ids=[int(k.split(":")[1]) for k in companies],
        )
    }
    max_id = _rows(conn, AWARDS_CTE + "SELECT max(aa.id) AS id FROM aa")[0]["id"]

    def named(p: dict, fallback_kind: str) -> dict:
        o = names.get(p["id"])
        if o is None:
            p.update(
                org_id=None,
                name="Agency not recorded",
                display_name="Not recorded",
                kind=fallback_kind,
                uei=None,
            )
        else:
            p.update(
                org_id=o["id"],
                name=o["canonical_name"],
                display_name=display_name(o["canonical_name"], o["kind"]),
                kind=o["kind"],
                uei=o["uei"],
            )
        return p

    def by_dollars(items) -> list[dict]:
        return sorted(items, key=lambda p: (-p["dollars"], p["id"]))

    company_list = []
    for c in by_dollars(companies.values()):
        md = c.pop("mission_dollars")
        c["missions"] = sorted(md, key=lambda t: (-md[t], t))
        # The first award on record, by date, and the first row the pipeline
        # loaded (the lowest id), which is what "new since a visit" compares.
        c["first_award"] = seen[c["id"]]["first_day"] if c["id"] in seen else None
        c["first_award_id"] = seen[c["id"]]["first_id"] if c["id"] in seen else None
        company_list.append(named(c, "company"))

    mission_list = []
    for m in missions.values():
        m["companies"] = len(m["companies"])
        mission_list.append(m)

    return {
        "window": {**w.as_dict(), "default": chosen, "today": today},
        "windows": [
            {**windows.resolve(k, latest, today=today).as_dict(), "awards": counts[k]}
            for k in windows.KEYS
        ],
        "sample": sample,
        "max_award_id": max_id,
        "totals": {
            "dollars": sum(c["dollars"] for c in company_list),
            "awards": len(out_awards),
            "companies": len(company_list),
            "agencies": sum(1 for g in agencies.values() if g["awards"]),
        },
        "agencies": [named(g, "agency") for g in by_dollars(agencies.values())],
        "missions": mission_list,
        "companies": company_list,
        "flows": sorted(
            bands.values(), key=lambda b: (b["kind"], -b["dollars"], b["source"], b["target"])
        ),
        "awards": out_awards,
        "solicitations": solicitations,
    }
