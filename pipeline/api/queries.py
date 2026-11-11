"""Read-only queries behind the public API.

Everything here counts only awards and opportunities the classifier tagged with
the taxonomy root, so a non-autonomy contract picked up by a source never
reaches the site. Organizations are always the live row (merged_into IS NULL);
merges repoint awards, so no extra hop is needed.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import psycopg
import yaml
from psycopg.rows import dict_row

TAXONOMY = Path(__file__).resolve().parent.parent.parent / "config" / "taxonomy.yaml"

# Awards tagged with the taxonomy root, with their non-root tag slugs and a
# usable date (DoD data can lack signed_at).
AWARDS_CTE = """
WITH aa AS (
    SELECT a.id, a.recipient_id, a.agency_id, a.amount, a.description, a.url,
           a.opportunity_id, a.source, a.source_id, a.fetched_at,
           COALESCE(a.signed_at, a.fetched_at::date) AS day,
           ARRAY(
               SELECT g.slug FROM taggings t JOIN tags g ON g.id = t.tag_id
               WHERE t.entity_type = 'award' AND t.entity_id = a.id AND g.slug <> %(root)s
               ORDER BY g.slug
           ) AS tags
    FROM awards a
    WHERE EXISTS (
        SELECT 1 FROM taggings t JOIN tags g ON g.id = t.tag_id
        WHERE t.entity_type = 'award' AND t.entity_id = a.id AND g.slug = %(root)s
    )
)
"""

OPP_TAGS = """ARRAY(
    SELECT g.slug FROM taggings t JOIN tags g ON g.id = t.tag_id
    WHERE t.entity_type = 'opportunity' AND t.entity_id = o.id AND g.slug <> %(root)s
    ORDER BY g.slug
)"""


@lru_cache
def taxonomy() -> dict:
    return yaml.safe_load(TAXONOMY.read_text())


def _root() -> str:
    return taxonomy()["root"]


def _rows(conn: psycopg.Connection, sql: str, **params) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, {"root": _root(), **params})
        return cur.fetchall()


def _one(conn: psycopg.Connection, sql: str, **params) -> dict | None:
    rows = _rows(conn, sql, **params)
    return rows[0] if rows else None


def _money(v) -> float:
    return float(v) if v is not None else 0.0


def tags() -> list[dict]:
    return [{"slug": s, "description": d} for s, d in taxonomy()["tags"].items()]


def summary(conn: psycopg.Connection) -> dict:
    """The hero's figures. The 30-day numbers and the open-solicitation count
    come from the signal views (migrations/007_signals.sql), so they match the
    dashboard exactly."""
    row = _one(
        conn,
        """
        SELECT m.as_of, m.sample,
               COALESCE(f.awards, 0) AS awards_30d, COALESCE(f.amount, 0) AS amount_30d,
               COALESCE(s.open, 0) AS open_opportunities,
               (SELECT count(*) FROM signal_awards) AS awards_total,
               (SELECT COALESCE(sum(amount), 0) FROM signal_awards) AS amount_total,
               (SELECT count(*) FROM signal_companies) AS companies,
               (SELECT max(fetched_at) FROM signal_awards) AS updated_at
        FROM signal_meta m
        LEFT JOIN signal_funding f
          ON f.window_days = 30 AND f.subject_type = 'total' AND f.slice = ''
        LEFT JOIN signal_solicitations s
          ON s.window_days = 30 AND s.subject_type = 'total' AND s.slice = ''
        """,
    )
    return {
        "awards_30d": row["awards_30d"],
        "amount_30d": _money(row["amount_30d"]),
        "awards_total": row["awards_total"],
        "amount_total": _money(row["amount_total"]),
        "companies": row["companies"],
        "open_opportunities": row["open_opportunities"],
        "updated_at": row["updated_at"],
        "as_of": row["as_of"],
        "sample": bool(row["sample"]),
    }


def recent(conn: psycopg.Connection, limit: int = 70) -> list[dict]:
    """Newest awards and open solicitations: one bird each."""
    n_opps = max(1, limit // 4)
    awards = _rows(
        conn,
        AWARDS_CTE
        + """
        SELECT 'award' AS kind, aa.id, aa.amount, aa.day, aa.description AS title, aa.tags,
               aa.url, o.id AS org_id, o.canonical_name AS org_name,
               ag.canonical_name AS agency_name, aa.day >= current_date AS is_new
        FROM aa
        LEFT JOIN organizations o ON o.id = aa.recipient_id
        LEFT JOIN organizations ag ON ag.id = aa.agency_id
        ORDER BY aa.day DESC, aa.id DESC
        LIMIT %(n)s
        """,
        n=limit - n_opps,
    )
    opps = _rows(
        conn,
        f"""
        SELECT 'opportunity' AS kind, o.id, NULL::numeric AS amount,
               COALESCE(o.posted_at, o.fetched_at)::date AS day, o.title, {OPP_TAGS} AS tags,
               o.url, ag.id AS org_id, ag.canonical_name AS org_name,
               ag.canonical_name AS agency_name, o.closes_at::date AS closes,
               COALESCE(o.posted_at, o.fetched_at)::date >= current_date AS is_new
        FROM opportunities o
        LEFT JOIN organizations ag ON ag.id = o.agency_id
        WHERE o.closes_at IS NULL OR o.closes_at > now()
        ORDER BY day DESC, o.id DESC
        LIMIT %(n)s
        """,
        n=n_opps,
    )
    items = awards + opps
    for it in items:
        it["amount"] = float(it["amount"]) if it["amount"] is not None else None
    items.sort(key=lambda it: (it["day"], it["id"]), reverse=True)
    return items


def _primary(tag_totals: dict[str, float]) -> str | None:
    return max(tag_totals, key=lambda k: (tag_totals[k], k)) if tag_totals else None


def graph(conn: psycopg.Connection, days: int = 90, max_companies: int = 150) -> dict:
    """Companies, agencies and solicitations in the window, with money edges.
    `days = 0` means everything on record."""
    rows = _rows(
        conn,
        AWARDS_CTE
        + """
        SELECT aa.recipient_id, aa.agency_id, aa.opportunity_id, aa.amount, aa.tags
        FROM aa
        WHERE (%(days)s = 0 OR aa.day >= current_date - %(days)s::int)
          AND aa.recipient_id IS NOT NULL
        """,
        days=days,
    )
    totals: dict[int, float] = {}
    for r in rows:
        totals[r["recipient_id"]] = totals.get(r["recipient_id"], 0.0) + _money(r["amount"])
    keep = set(sorted(totals, key=lambda k: totals[k], reverse=True)[:max_companies])

    nodes: dict[str, dict] = {}
    edges: dict[tuple[str, str, str], dict] = {}

    def node(key: str) -> dict:
        return nodes.setdefault(key, {"id": key, "total": 0.0, "awards": 0, "tag_totals": {}})

    def bump(n: dict, amount: float, tags_: list[str]) -> None:
        n["total"] += amount
        n["awards"] += 1
        for t in tags_:
            n["tag_totals"][t] = n["tag_totals"].get(t, 0.0) + amount

    def edge(src: str, dst: str, kind: str, amount: float = 0.0) -> None:
        e = edges.setdefault(
            (src, dst, kind), {"source": src, "target": dst, "kind": kind, "amount": 0.0, "n": 0}
        )
        e["amount"] += amount
        e["n"] += 1

    opp_ids: set[int] = set()
    for r in rows:
        if r["recipient_id"] not in keep:
            continue
        amount = _money(r["amount"])
        co = f"org:{r['recipient_id']}"
        bump(node(co), amount, r["tags"])
        if r["agency_id"]:
            ag = f"org:{r['agency_id']}"
            bump(node(ag), amount, r["tags"])
            edge(ag, co, "award", amount)
        if r["opportunity_id"]:
            op = f"opp:{r['opportunity_id']}"
            opp_ids.add(r["opportunity_id"])
            bump(node(op), amount, r["tags"])
            edge(op, co, "answered")

    # Solicitations posted in the window, plus any an in-window award answered.
    for o in _rows(
        conn,
        f"""
        SELECT o.id, o.title, o.agency_id, o.url, o.posted_at::date AS posted,
               o.closes_at::date AS closes, {OPP_TAGS} AS tags,
               (o.closes_at IS NULL OR o.closes_at > now()) AS open
        FROM opportunities o
        WHERE o.id = ANY(%(ids)s)
           OR %(days)s = 0
           OR COALESCE(o.posted_at, o.fetched_at) >= current_date - %(days)s::int
        """,
        ids=list(opp_ids),
        days=days,
    ):
        n = node(f"opp:{o['id']}")
        n.update(
            kind="opportunity",
            name=o["title"],
            url=o["url"],
            posted=o["posted"],
            closes=o["closes"],
            open=o["open"],
        )
        for t in o["tags"]:
            n["tag_totals"].setdefault(t, 0.0)
        if o["agency_id"]:
            node(f"org:{o['agency_id']}")
            edge(f"org:{o['agency_id']}", f"opp:{o['id']}", "issued")

    org_ids = [int(k.split(":")[1]) for k in nodes if k.startswith("org:")]
    for o in _rows(
        conn,
        "SELECT id, canonical_name, kind, uei FROM organizations WHERE id = ANY(%(ids)s)",
        ids=org_ids,
    ):
        nodes[f"org:{o['id']}"].update(kind=o["kind"], name=o["canonical_name"], uei=o["uei"])

    for e in _rows(
        conn,
        """
        SELECT src_id, dst_id FROM edges
        WHERE rel = 'part_of' AND src_type = 'organization' AND dst_type = 'organization'
          AND src_id = ANY(%(ids)s) AND dst_id = ANY(%(ids)s)
        """,
        ids=org_ids,
    ):
        edge(f"org:{e['src_id']}", f"org:{e['dst_id']}", "part_of")

    out = []
    for n in nodes.values():
        if "kind" not in n:  # an org row that vanished mid-query
            continue
        tt = n.pop("tag_totals")
        n["tags"] = sorted(tt)
        n["tag"] = _primary(tt)
        out.append(n)
    ids = {n["id"] for n in out}
    return {
        "days": days,
        "nodes": out,
        "edges": [e for e in edges.values() if e["source"] in ids and e["target"] in ids],
    }


# Stage detection is a text heuristic over award descriptions: the schema has no
# phase column. SBIR/STTR awards say "Phase I"/"Phase II"; production contracts
# use procurement language.
_PHASE_2 = re.compile(r"\bphase\s*(ii|2)\b", re.I)
_PHASE_1 = re.compile(r"\bphase\s*(i|1)\b", re.I)
_PRODUCTION = re.compile(r"\b(production|full[- ]rate|lrip|low[- ]rate initial|procure)", re.I)


def _stage_of(description: str | None) -> str | None:
    text = description or ""
    if _PHASE_2.search(text):
        return "phase_2"
    if _PHASE_1.search(text):
        return "phase_1"
    if _PRODUCTION.search(text):
        return "production"
    return None


def _path(awards: list[dict], opportunities: list[dict]) -> list[dict]:
    stages = {
        k: {"key": k, "label": label, "reached": False, "date": None, "amount": 0.0, "n": 0}
        for k, label in [
            ("solicitation", "Solicitation"),
            ("phase_1", "Phase I"),
            ("phase_2", "Phase II"),
            ("production", "Production"),
        ]
    }

    def mark(key: str, day: date | None, amount: float) -> None:
        s = stages[key]
        s["reached"] = True
        s["n"] += 1
        s["amount"] += amount
        if day and (s["date"] is None or day < s["date"]):
            s["date"] = day

    for o in opportunities:
        mark("solicitation", o["posted"], 0.0)
    for a in awards:
        if key := _stage_of(a["description"]):
            mark(key, a["day"], a["amount"] or 0.0)
    return list(stages.values())


def org(conn: psycopg.Connection, org_id: int) -> dict | None:
    row = None
    for _ in range(20):  # follow merges to the live row
        row = _one(
            conn,
            "SELECT id, canonical_name, kind, uei, aliases, merged_into, source"
            " FROM organizations WHERE id = %(id)s",
            id=org_id,
        )
        if row is None or row["merged_into"] is None:
            break
        org_id = row["merged_into"]
    if row is None:
        return None

    col = "recipient_id" if row["kind"] == "company" else "agency_id"
    other = "agency_id" if row["kind"] == "company" else "recipient_id"
    awards = _rows(
        conn,
        AWARDS_CTE
        + f"""
        SELECT aa.id, aa.amount, aa.day, aa.description, aa.url, aa.tags, aa.source,
               aa.source_id, aa.opportunity_id, x.id AS other_id, x.canonical_name AS other_name
        FROM aa LEFT JOIN organizations x ON x.id = aa.{other}
        WHERE aa.{col} = %(id)s
        ORDER BY aa.day DESC, aa.id DESC
        """,
        id=org_id,
    )
    tag_totals: dict[str, float] = {}
    related: dict[int, dict] = {}
    for a in awards:
        a["amount"] = float(a["amount"]) if a["amount"] is not None else None
        a["stage"] = _stage_of(a["description"])
        for t in a["tags"]:
            tag_totals[t] = tag_totals.get(t, 0.0) + (a["amount"] or 0.0)
        if a["other_id"]:
            r = related.setdefault(
                a["other_id"],
                {"id": a["other_id"], "name": a["other_name"], "total": 0.0, "awards": 0},
            )
            r["total"] += a["amount"] or 0.0
            r["awards"] += 1

    opp_ids = sorted({a["opportunity_id"] for a in awards if a["opportunity_id"]})
    where = "o.id = ANY(%(ids)s)" if row["kind"] == "company" else "o.agency_id = %(id)s"
    opportunities = _rows(
        conn,
        f"""
        SELECT o.id, o.title, o.url, COALESCE(o.posted_at, o.fetched_at)::date AS posted,
               o.closes_at::date AS closes, (o.closes_at IS NULL OR o.closes_at > now()) AS open
        FROM opportunities o WHERE {where}
        ORDER BY posted DESC LIMIT 40
        """,
        ids=opp_ids,
        id=org_id,
    )
    family = _rows(
        conn,
        """
        SELECT o.id, o.canonical_name AS name, o.kind,
               CASE WHEN e.src_id = %(id)s THEN 'parent' ELSE 'child' END AS relation
        FROM edges e
        JOIN organizations o
          ON o.id = CASE WHEN e.src_id = %(id)s THEN e.dst_id ELSE e.src_id END
        WHERE e.rel = 'part_of' AND e.src_type = 'organization' AND e.dst_type = 'organization'
          AND %(id)s IN (e.src_id, e.dst_id) AND o.merged_into IS NULL
        ORDER BY relation DESC, o.canonical_name LIMIT 12
        """,
        id=org_id,
    )
    kinds = {
        r["id"]: r["kind"]
        for r in _rows(
            conn, "SELECT id, kind FROM organizations WHERE id = ANY(%(ids)s)", ids=list(related)
        )
    }
    top_related = sorted(related.values(), key=lambda r: r["total"], reverse=True)[:8]
    for r in top_related:
        r["kind"] = kinds.get(r["id"], "company")

    sources = [
        {"label": f"{a['source']} · {a['source_id']}", "url": a["url"], "day": a["day"]}
        for a in awards
        if a["url"]
    ][:25]

    return {
        "id": row["id"],
        "name": row["canonical_name"],
        "kind": row["kind"],
        "uei": row["uei"],
        "aliases": row["aliases"],
        "tags": [
            {"slug": t, "amount": v}
            for t, v in sorted(tag_totals.items(), key=lambda kv: kv[1], reverse=True)
        ],
        "tag": _primary(tag_totals),
        "total": sum(a["amount"] or 0.0 for a in awards),
        "award_count": len(awards),
        "first_award": awards[-1]["day"] if awards else None,
        "last_award": awards[0]["day"] if awards else None,
        "days_since_last": (date.today() - awards[0]["day"]).days if awards else None,
        "path": _path(awards, opportunities) if row["kind"] == "company" else None,
        "awards": awards[:200],
        "related": top_related,
        "family": family,
        "opportunities": opportunities,
        "sources": sources,
    }


def search(conn: psycopg.Connection, q: str, limit: int = 12) -> list[dict]:
    q = q.strip()
    if not q:
        return []
    like = "%" + q.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"
    return _rows(
        conn,
        """
        SELECT o.id, o.canonical_name AS name, o.kind, o.uei
        FROM organizations o
        WHERE o.merged_into IS NULL
          AND (o.canonical_name ILIKE %(like)s OR o.uei ILIKE %(like)s
               OR EXISTS (SELECT 1 FROM unnest(o.aliases) a WHERE a ILIKE %(like)s))
        ORDER BY (o.canonical_name ILIKE %(prefix)s) DESC, length(o.canonical_name),
                 o.canonical_name
        LIMIT %(n)s
        """,
        like=like,
        prefix=like[1:],
        n=limit,
    )


def digest(conn: psycopg.Connection) -> dict:
    """The last seven days against the seven before, for the field report.

    Read from the signal views, with the 7-day window: the same rows and the
    same as-of date as the dashboard, so the two never disagree."""
    meta = _one(conn, "SELECT as_of FROM signal_meta")
    today = meta["as_of"]
    start = today - timedelta(days=6)
    week = _one(
        conn,
        """SELECT amount, awards, prev_amount, prev_awards FROM signal_funding
           WHERE window_days = 7 AND subject_type = 'total' AND slice = ''""",
    ) or {"amount": 0, "awards": 0, "prev_amount": 0, "prev_awards": 0}
    top = _rows(
        conn,
        """
        SELECT a.id, a.amount, a.day, a.description, a.tags, a.url,
               o.id AS org_id, o.canonical_name AS org_name,
               ag.id AS agency_id, ag.canonical_name AS agency_name
        FROM signal_awards a
        LEFT JOIN organizations o ON o.id = a.recipient_id
        LEFT JOIN organizations ag ON ag.id = a.agency_id
        WHERE a.day >= %(start)s AND a.day <= %(today)s AND a.amount IS NOT NULL
        ORDER BY a.amount DESC, a.id LIMIT 5
        """,
        start=start,
        today=today,
    )
    by_tag = _rows(
        conn,
        """
        SELECT slice AS slug, awards AS n, amount FROM signal_funding
        WHERE window_days = 7 AND subject_type = 'total' AND slice <> '' AND awards > 0
        ORDER BY amount DESC, slice LIMIT 4
        """,
    )
    newcomers = _rows(
        conn,
        """
        SELECT o.id, o.canonical_name AS name, c.first_day, c.amount
        FROM signal_companies c JOIN organizations o ON o.id = c.org_id
        WHERE c.first_day >= %(start)s AND c.first_day <= %(today)s
        ORDER BY c.amount DESC, o.id LIMIT 5
        """,
        start=start,
        today=today,
    )
    opened = _rows(
        conn,
        """
        SELECT o.id, o.title, o.url, o.day AS posted, o.closes_at::date AS closes,
               ag.id AS agency_id, ag.canonical_name AS agency_name
        FROM signal_opportunities o LEFT JOIN organizations ag ON ag.id = o.agency_id
        WHERE o.day >= %(start)s AND o.day <= %(today)s
        ORDER BY o.day DESC, o.id DESC LIMIT 5
        """,
        start=start,
        today=today,
    )
    closing = _rows(
        conn,
        """
        SELECT o.id, o.title, o.url, o.closes_at::date AS closes,
               ag.id AS agency_id, ag.canonical_name AS agency_name
        FROM signal_opportunities o LEFT JOIN organizations ag ON ag.id = o.agency_id
        WHERE o.closes_at::date > %(today)s AND o.closes_at::date <= %(today)s::date + 14
        ORDER BY o.closes_at LIMIT 4
        """,
        today=today,
    )
    for r in top:
        r["amount"] = _money(r["amount"])
    for r in by_tag + newcomers:
        r["amount"] = _money(r["amount"])
    return {
        "week_of": start,
        "through": today,
        "awards": week["awards"],
        "amount": _money(week["amount"]),
        "prev_awards": week["prev_awards"],
        "prev_amount": _money(week["prev_amount"]),
        "top": top,
        "by_tag": by_tag,
        "newcomers": newcomers,
        "opened": opened,
        "closing": closing,
    }
