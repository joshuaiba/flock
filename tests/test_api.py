"""Read-only API over a seeded database."""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from pipeline import signals
from pipeline.api import queries, seed
from pipeline.api.app import app, get_conn


@pytest.fixture
def seeded(db):
    counts = seed.seed(db)
    app.dependency_overrides[get_conn] = lambda: db
    yield TestClient(app), db, counts
    app.dependency_overrides.clear()


def test_summary_counts_only_autonomy_awards(seeded):
    client, db, counts = seeded
    body = client.get("/api/summary").json()
    # The seed adds one untagged $950M award; it must not be counted.
    assert db.execute("SELECT count(*) FROM awards").fetchone()[0] == counts["awards"] + 1
    assert body["awards_total"] == counts["awards"]
    assert body["companies"] == counts["companies"]
    assert body["sample"] is True
    assert 0 < body["awards_30d"] <= body["awards_total"]


def test_recent_is_newest_first_and_mixed(seeded):
    client, _, _ = seeded
    items = client.get("/api/recent", params={"limit": 40}).json()
    assert len(items) == 40
    assert {i["kind"] for i in items} == {"award", "opportunity"}
    assert [i["day"] for i in items] == sorted((i["day"] for i in items), reverse=True)
    assert all(i["org_name"] for i in items)
    assert client.get("/api/recent", params={"limit": 0}).status_code == 422


def test_graph_edges_join_known_nodes_and_exclude_untagged(seeded):
    client, db, _ = seeded
    g = client.get("/api/graph", params={"days": 365}).json()
    ids = {n["id"] for n in g["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in g["edges"])
    assert {n["kind"] for n in g["nodes"]} >= {"company", "agency", "office", "opportunity"}
    awarded = sum(e["amount"] for e in g["edges"] if e["kind"] == "award")
    (expected,) = db.execute(
        "SELECT sum(amount) FROM awards WHERE source_id <> 'award-not-autonomy'"
        " AND signed_at > current_date - 365"
    ).fetchone()
    assert awarded == pytest.approx(float(expected))
    assert client.get("/api/graph", params={"days": 7}).status_code == 422


def test_graph_window_narrows(seeded):
    client, _, _ = seeded
    wide = client.get("/api/graph", params={"days": 365}).json()
    narrow = client.get("/api/graph", params={"days": 30}).json()
    total = lambda g: sum(e["amount"] for e in g["edges"] if e["kind"] == "award")  # noqa: E731
    assert 0 < total(narrow) < total(wide)
    # 0 means everything on record: at least as much as the widest window.
    everything = client.get("/api/graph", params={"days": 0}).json()
    assert total(everything) >= total(wide)
    assert len(everything["nodes"]) >= len(wide["nodes"])


def test_graph_recent_window_ends_on_the_newest_award(seeded):
    client, db, _ = seeded
    # A record that was last loaded 200 days ago: nothing is recent by the calendar.
    db.execute(
        "UPDATE awards SET signed_at = signed_at - 200,"
        " fetched_at = fetched_at - interval '200 days'"
    )
    db.execute(
        "UPDATE opportunities SET posted_at = posted_at - interval '200 days',"
        " fetched_at = fetched_at - interval '200 days'"
    )
    total = lambda g: sum(e["amount"] for e in g["edges"] if e["kind"] == "award")  # noqa: E731
    by_calendar = client.get("/api/graph", params={"days": 90}).json()
    assert total(by_calendar) == 0
    assert by_calendar["age"] == 200
    assert by_calendar["recent"] is False

    recent = client.get("/api/graph", params={"days": 90, "recent": True}).json()
    assert total(recent) > 0
    assert recent["recent"] is True
    assert recent["through"] == recent["latest"] == by_calendar["latest"]
    (expected,) = db.execute(
        "SELECT sum(amount) FROM awards WHERE source_id <> 'award-not-autonomy'"
        " AND signed_at > (SELECT max(signed_at) FROM awards"
        " WHERE source_id <> 'award-not-autonomy') - 90"
    ).fetchone()
    assert total(recent) == pytest.approx(float(expected))


def test_graph_windows_cover_the_same_days_as_the_dashboard(seeded):
    """The graph's window and the Forum's are one rule: N days ending on the
    newest autonomy award not dated after today. Same end day, same first day,
    same dollars, on a record that ends 94 days ago."""
    client, db, _ = seeded
    db.execute(
        "UPDATE awards SET signed_at = signed_at - 94, fetched_at = fetched_at - interval '94 days'"
    )
    (newest,) = db.execute(
        "SELECT max(signed_at) FROM awards WHERE source_id <> 'award-not-autonomy'"
    ).fetchone()

    def award(key: str, day, amount: int) -> None:
        """One more autonomy award, between a company and an agency of the seed."""
        (aid,) = db.execute(
            """INSERT INTO awards (recipient_id, agency_id, amount, signed_at, description,
                                   source, source_id)
               SELECT a.recipient_id, a.agency_id, %s, %s, 'Research', 'test', %s
               FROM awards a WHERE a.source_id = 'award-1' RETURNING id""",
            (amount, day, key),
        ).fetchone()
        db.execute(
            """INSERT INTO taggings (entity_type, entity_id, tag_id, source, source_id)
               SELECT 'award', %s, id, 'test', %s FROM tags WHERE slug = %s""",
            (aid, key, queries.taxonomy()["root"]),
        )

    # The edges of the 90-day window, and an award dated after today, which is
    # a mistake in a source and must not move either page's window.
    award("first-day", newest - timedelta(days=89), 1_000_000)
    award("day-before", newest - timedelta(days=90), 2_000_000)
    award("typo", newest + timedelta(days=94 + 30), 4_000_000)
    signals.refresh(db)

    total = lambda g: sum(e["amount"] for e in g["edges"] if e["kind"] == "award")  # noqa: E731
    for days in (30, 90, 365):
        g = client.get("/api/graph", params={"days": days, "recent": True}).json()
        forum = client.get("/api/signals/overview", params={"window": days}).json()
        assert g["latest"] == g["through"] == forum["as_of"] == str(newest), days
        assert g["since"] == str(newest - timedelta(days=days - 1)), days
        assert g["age"] == 94
        assert total(g) == pytest.approx(forum["amount"]), days
    quarter = client.get("/api/graph", params={"days": 90, "recent": True}).json()
    (expected,) = db.execute(
        "SELECT sum(amount) FROM awards WHERE source_id NOT IN ('award-not-autonomy', 'typo')"
        " AND signed_at > %s AND signed_at <= %s",
        (newest - timedelta(days=90), newest),
    ).fetchone()
    assert total(quarter) == pytest.approx(float(expected))  # first-day in, day-before out
    # Everything on record is everything: no window, so the mis-dated award too.
    everything = client.get("/api/graph", params={"days": 0}).json()
    (on_record,) = db.execute(
        "SELECT sum(amount) FROM awards WHERE source_id <> 'award-not-autonomy'"
    ).fetchone()
    assert total(everything) == pytest.approx(float(on_record))


def test_org_page_for_company(seeded):
    client, db, _ = seeded
    (org_id,) = db.execute(
        "SELECT recipient_id FROM awards WHERE description LIKE 'SBIR Phase II%' LIMIT 1"
    ).fetchone()
    body = client.get(f"/api/orgs/{org_id}").json()
    assert body["kind"] == "company"
    assert body["award_count"] == len(body["awards"]) > 0
    assert body["total"] == pytest.approx(sum(a["amount"] for a in body["awards"]))
    stages = {s["key"]: s for s in body["path"]}
    assert list(stages) == ["solicitation", "phase_1", "phase_2", "production"]
    assert stages["phase_2"]["reached"] and stages["phase_2"]["amount"] > 0
    assert body["related"] and body["sources"]
    assert body["days_since_last"] >= 0


def test_org_page_for_agency_has_no_path(seeded):
    client, db, _ = seeded
    (org_id,) = db.execute(
        "SELECT id FROM organizations WHERE canonical_name = 'Department of the Navy'"
    ).fetchone()
    body = client.get(f"/api/orgs/{org_id}").json()
    assert body["path"] is None
    # The untagged destroyer contract belongs to the Navy and stays hidden.
    assert all("Destroyer" not in (a["description"] or "") for a in body["awards"])
    assert {f["relation"] for f in body["family"]} == {"parent", "child"}


def test_org_follows_merge_to_canonical_row(seeded):
    client, db, _ = seeded
    (canonical,) = db.execute(
        "SELECT id FROM organizations WHERE kind = 'company' ORDER BY id LIMIT 1"
    ).fetchone()
    (merged,) = db.execute(
        """INSERT INTO organizations (canonical_name, kind, source, source_id, merged_into)
           VALUES ('Old Spelling LLC', 'company', 'test', 'old', %s) RETURNING id""",
        (canonical,),
    ).fetchone()
    assert client.get(f"/api/orgs/{merged}").json()["id"] == canonical
    assert client.get("/api/orgs/99999999").status_code == 404
    # Merged rows never show up in search.
    assert client.get("/api/search", params={"q": "Old Spelling"}).json() == []


def test_search_matches_names_and_escapes_wildcards(seeded):
    client, db, _ = seeded
    (name,) = db.execute(
        "SELECT canonical_name FROM organizations WHERE kind = 'company' ORDER BY id LIMIT 1"
    ).fetchone()
    hits = client.get("/api/search", params={"q": name[:5].lower()}).json()
    assert name in [h["name"] for h in hits]
    assert client.get("/api/search", params={"q": "%"}).json() == []
    assert client.get("/api/search", params={"q": "  "}).json() == []


def test_digest_covers_the_last_seven_days(seeded):
    client, _, _ = seeded
    d = client.get("/api/digest").json()
    assert d["awards"] > 0 and d["amount"] > 0
    assert [a["amount"] for a in d["top"]] == sorted((a["amount"] for a in d["top"]), reverse=True)
    assert all(a["day"] >= d["week_of"] for a in d["top"])
    assert d["newcomers"], "the seed plants companies whose whole history is this week"


def test_summary_and_digest_follow_a_record_that_ends_94_days_ago(seeded):
    """The hero's 30-day figures and the field report's week come from the
    signal views, whose windows end on the newest award on record. A record
    last added to 94 days ago still fills them; by the calendar it would not."""
    client, db, _ = seeded
    before = client.get("/api/summary").json(), client.get("/api/digest").json()
    db.execute(
        "UPDATE awards SET signed_at = signed_at - 94, fetched_at = fetched_at - interval '94 days'"
    )
    db.execute(
        "UPDATE opportunities SET posted_at = posted_at - interval '94 days',"
        " closes_at = closes_at - interval '94 days',"
        " fetched_at = fetched_at - interval '94 days'"
    )
    signals.refresh(db)
    (newest,) = db.execute(
        "SELECT max(signed_at) FROM awards WHERE source_id <> 'award-not-autonomy'"
    ).fetchone()
    (today,) = db.execute("SELECT current_date").fetchone()
    assert (today - newest).days == 94
    assert client.get("/api/graph", params={"days": 90}).json()["nodes"] == []  # by the calendar

    summary = client.get("/api/summary").json()
    assert summary["as_of"] == str(newest)
    assert summary["awards_30d"] > 0 and summary["amount_30d"] > 0
    # The whole record moved back together, so the figures are the ones it had.
    for key in ("awards_30d", "amount_30d", "awards_total", "open_opportunities"):
        assert summary[key] == before[0][key], key

    digest = client.get("/api/digest").json()
    assert digest["through"] == str(newest)
    assert digest["week_of"] == str(newest - timedelta(days=6))
    assert digest["awards"] > 0 and digest["top"] and digest["newcomers"]
    assert all(digest["week_of"] <= a["day"] <= digest["through"] for a in digest["top"])
    for key in ("awards", "amount", "prev_awards", "prev_amount"):
        assert digest[key] == before[1][key], key
    # "Closing soon" is by the calendar: nothing that closed months ago.
    assert all(o["closes"] > str(today) for o in digest["closing"])


def test_tags_come_from_the_taxonomy():
    slugs = [t["slug"] for t in TestClient(app).get("/api/tags").json()]
    assert slugs == list(queries.taxonomy()["tags"])


@pytest.mark.parametrize(
    ("text", "stage"),
    [
        ("SBIR Phase I: feasibility study", "phase_1"),
        ("SBIR Phase II prototype", "phase_2"),
        ("STTR phase 2 award", "phase_2"),
        ("Full-rate production of air vehicles", "production"),
        ("Low-rate initial production lot 3", "production"),
        ("Research and development", None),
        (None, None),
    ],
)
def test_stage_is_read_from_the_description(text, stage):
    assert queries._stage_of(text) == stage


def test_graph_nodes_carry_short_names_and_the_sample_flag(seeded):
    client, _, _ = seeded
    g = client.get("/api/graph", params={"days": 365}).json()
    assert g["sample"] is True
    by_name = {n["name"]: n for n in g["nodes"]}
    assert by_name["Department of the Army"]["display_name"] == "Army"
    assert by_name["U.S. Special Operations Command"]["display_name"] == "SOCOM"
    assert by_name["Air Force Research Laboratory"]["display_name"] == "AFRL"
    for n in g["nodes"]:
        if n["kind"] == "company":
            # The seed's names end in a legal suffix; the label drops it.
            assert n["display_name"] and n["name"].startswith(n["display_name"])
            assert n["display_name"] != n["name"]
        elif n["kind"] == "opportunity":
            assert n.get("display_name") is None


def test_graph_sample_is_false_without_seed_rows(seeded):
    client, db, _ = seeded
    db.execute("UPDATE awards SET source = 'usaspending' WHERE source = 'seed'")
    assert client.get("/api/graph", params={"days": 365}).json()["sample"] is False
