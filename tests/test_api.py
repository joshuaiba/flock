"""Read-only API over a seeded database."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

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


def _band_total(body: dict, kind: str) -> float:
    return sum(f["dollars"] for f in body["flows"] if f["kind"] == kind)


def test_flows_add_up_and_exclude_untagged(seeded):
    client, db, _ = seeded
    body = client.get("/api/flows", params={"window": "1y"}).json()
    w = body["window"]
    (expected, n) = db.execute(
        "SELECT sum(amount), count(*) FROM awards WHERE source_id <> 'award-not-autonomy'"
        " AND signed_at BETWEEN %s AND %s",
        (w["start"], w["end"]),
    ).fetchone()
    # Every column of the flow carries the same dollars: the awards' own total.
    for kind in ("agency-mission", "mission-company", "agency-company"):
        assert _band_total(body, kind) == pytest.approx(float(expected))
    assert body["totals"]["dollars"] == pytest.approx(float(expected))
    assert body["totals"]["awards"] == len(body["awards"]) == n
    assert sum(c["dollars"] for c in body["companies"]) == pytest.approx(float(expected))
    assert sum(m["dollars"] for m in body["missions"]) == pytest.approx(float(expected))
    # Flows join known parties, and each names the awards behind it.
    ids = {x["id"] for group in ("agencies", "missions", "companies") for x in body[group]}
    award_ids = {a["id"] for a in body["awards"]}
    for f in body["flows"]:
        assert f["source"] in ids and f["target"] in ids
        assert f["award_ids"] and set(f["award_ids"]) <= award_ids
    assert client.get("/api/flows", params={"window": "7d"}).status_code == 422


def test_flow_awards_link_to_their_source_records(seeded):
    client, _, _ = seeded
    body = client.get("/api/flows", params={"window": "90d"}).json()
    assert body["awards"]
    for a in body["awards"]:
        assert a["url"].startswith("https://")
        assert a["source"] and a["source_id"]
        assert a["missions"]
    assert [a["day"] for a in body["awards"]] == sorted(a["day"] for a in body["awards"])


def test_flows_list_every_mission_in_taxonomy_order(seeded):
    client, _, _ = seeded
    body = client.get("/api/flows", params={"window": "30d"}).json()
    assert [m["slug"] for m in body["missions"]] == list(queries.taxonomy()["tags"])
    assert all(m["id"] == f"tag:{m['slug']}" for m in body["missions"])


def test_flow_windows_narrow(seeded):
    client, _, _ = seeded
    total = lambda key: client.get("/api/flows", params={"window": key}).json()["totals"]  # noqa: E731
    assert 0 < total("30d")["dollars"] < total("90d")["dollars"] < total("1y")["dollars"]
    assert total("all")["awards"] >= total("1y")["awards"]


def _age_the_record(db, days: int) -> None:
    """A record whose newest award is `days` days old, like the real one."""
    db.execute(
        "UPDATE awards SET signed_at = signed_at - %s::int,"
        " fetched_at = fetched_at - make_interval(days => %s)",
        (days, days),
    )
    db.execute(
        "UPDATE opportunities SET posted_at = posted_at - make_interval(days => %s),"
        " closes_at = closes_at - make_interval(days => %s),"
        " fetched_at = fetched_at - make_interval(days => %s)",
        (days, days, days),
    )


def test_every_window_ends_on_the_newest_award_however_old(seeded):
    client, db, _ = seeded
    # 94 days stale: Nov 21 against a record that ends Aug 19. The last 90
    # calendar days hold nothing, which is what left the 90d window empty.
    _age_the_record(db, 94)
    (latest,) = db.execute(
        "SELECT max(signed_at) FROM awards WHERE source_id <> 'award-not-autonomy'"
    ).fetchone()
    assert (
        db.execute(
            "SELECT count(*) FROM awards WHERE signed_at >= current_date - 90"
            " AND source_id <> 'award-not-autonomy'"
        ).fetchone()[0]
        == 0
    )
    for key, days in (("30d", 30), ("90d", 90), ("1y", 365)):
        body = client.get("/api/flows", params={"window": key}).json()
        w = body["window"]
        assert w["end"] == w["latest_data_date"] == latest.isoformat()
        assert w["label"].startswith(("30 days to", "90 days to", "1 year to"))
        (expected, n) = db.execute(
            "SELECT sum(amount), count(*) FROM awards WHERE source_id <> 'award-not-autonomy'"
            " AND signed_at > %s::date - %s::int AND signed_at <= %s",
            (latest, days, latest),
        ).fetchone()
        assert n > 0
        assert body["totals"]["awards"] == n
        assert body["totals"]["dollars"] == pytest.approx(float(expected))


def test_recent_is_served_as_the_90_day_window(seeded):
    client, db, _ = seeded
    _age_the_record(db, 94)
    recent = client.get("/api/flows", params={"window": "recent"}).json()
    ninety = client.get("/api/flows", params={"window": "90d"}).json()
    assert recent["window"]["key"] == "90d"
    assert recent["totals"] == ninety["totals"]


def test_the_default_window_is_never_empty_and_says_which_it_is(seeded):
    client, db, _ = seeded
    _age_the_record(db, 94)
    body = client.get("/api/flows").json()
    assert body["window"]["default"] is True
    assert body["window"]["key"] == "90d"
    assert body["totals"]["awards"] > 0
    assert [w["key"] for w in body["windows"]] == ["30d", "90d", "1y", "all"]
    assert all(w["awards"] > 0 for w in body["windows"])
    # Asked for by name, the same window is not marked as the default.
    assert client.get("/api/flows", params={"window": "90d"}).json()["window"]["default"] is False


def test_the_default_skips_windows_with_no_award(seeded):
    client, db, _ = seeded
    # With no autonomy award on record, every window is empty: the answer is
    # the "all" window with nothing in it, never an error.
    db.execute("DELETE FROM taggings WHERE entity_type = 'award'")
    body = client.get("/api/flows").json()
    assert body["window"]["key"] == "all"
    assert body["window"]["end"] is None
    assert body["totals"]["awards"] == 0
    assert body["awards"] == [] and body["flows"] == []


def test_a_multi_mission_award_splits_its_dollars_evenly(seeded):
    client, db, _ = seeded
    body = client.get("/api/flows", params={"window": "all"}).json()
    shared = next(a for a in body["awards"] if len(a["missions"]) == 1)
    # Give one award a second mission, then ask again.
    other = next(m["slug"] for m in body["missions"] if m["slug"] not in shared["missions"])
    (tag_id,) = db.execute("SELECT id FROM tags WHERE slug = %s", (other,)).fetchone()
    db.execute(
        "INSERT INTO taggings (entity_type, entity_id, tag_id, confidence, source, source_id)"
        " VALUES ('award', %s, %s, 0.9, 'seed', 'extra')",
        (shared["id"], tag_id),
    )
    again = client.get("/api/flows", params={"window": "all"}).json()
    award = next(a for a in again["awards"] if a["id"] == shared["id"])
    assert sorted(award["missions"]) == sorted([*shared["missions"], other])
    for kind in ("agency-mission", "mission-company", "agency-company"):
        assert _band_total(again, kind) == pytest.approx(_band_total(body, kind))
    before = {m["slug"]: m["dollars"] for m in body["missions"]}
    after = {m["slug"]: m["dollars"] for m in again["missions"]}
    assert after[other] - before[other] == pytest.approx(shared["amount"] / 2)


def test_flows_carry_solicitations_and_what_answered_them(seeded):
    client, _, _ = seeded
    body = client.get("/api/flows", params={"window": "all"}).json()
    assert body["solicitations"]
    answered = [s for s in body["solicitations"] if s["award_ids"]]
    assert answered and all(s["awarded_on"] for s in answered)
    by_id = {a["id"]: a for a in body["awards"]}
    for s in answered:
        assert all(by_id[i]["opportunity"] == s["id"] for i in s["award_ids"])
    agencies = {a["id"] for a in body["agencies"]}
    assert all(s["agency"] in agencies for s in body["solicitations"])


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


def test_flow_parties_carry_short_names_and_the_sample_flag(seeded):
    client, _, _ = seeded
    body = client.get("/api/flows", params={"window": "1y"}).json()
    assert body["sample"] is True
    by_name = {a["name"]: a for a in body["agencies"]}
    assert by_name["Department of the Army"]["display_name"] == "Army"
    assert by_name["U.S. Special Operations Command"]["display_name"] == "SOCOM"
    assert by_name["Air Force Research Laboratory"]["display_name"] == "AFRL"
    for c in body["companies"]:
        # The seed's names end in a legal suffix; the label drops it.
        assert c["display_name"] and c["name"].startswith(c["display_name"])
        assert c["display_name"] != c["name"]
        assert c["first_award"] and c["first_award_id"] and c["missions"]
    assert body["max_award_id"] >= max(a["id"] for a in body["awards"])


def test_flow_sample_is_false_without_seed_rows(seeded):
    client, db, _ = seeded
    db.execute("UPDATE awards SET source = 'usaspending' WHERE source = 'seed'")
    assert client.get("/api/flows", params={"window": "1y"}).json()["sample"] is False
