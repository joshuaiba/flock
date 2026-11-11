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


def test_graph_edges_join_known_nodes_and_exclude_untagged(seeded):
    client, db, _ = seeded
    g = client.get("/api/graph", params={"days": 365}).json()
    ids = {n["id"] for n in g["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in g["edges"])
    assert {n["kind"] for n in g["nodes"]} >= {"company", "agency", "office", "opportunity"}
    awarded = sum(e["amount"] for e in g["edges"] if e["kind"] == "award")
    (expected,) = db.execute(
        "SELECT sum(amount) FROM awards WHERE source_id <> 'award-not-autonomy'"
        " AND signed_at >= current_date - 365"
    ).fetchone()
    assert awarded == pytest.approx(float(expected))
    assert client.get("/api/graph", params={"days": 7}).status_code == 422


def test_graph_window_narrows(seeded):
    client, _, _ = seeded
    wide = client.get("/api/graph", params={"days": 365}).json()
    narrow = client.get("/api/graph", params={"days": 30}).json()
    total = lambda g: sum(e["amount"] for e in g["edges"] if e["kind"] == "award")  # noqa: E731
    assert 0 < total(narrow) < total(wide)


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
