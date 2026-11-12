"""Signals (migrations/007_signals.sql, pipeline/api/signals.py) over a small
hand-built data set where every answer can be worked out by reading the rows.

T is today, the day the views are refreshed. The 90-day window is (T-90, T];
the prior period is (T-180, T-90].

    company   category            awards
    Alpha     maritime            T-10  $1,000,000  "SBIR Phase II ..."   (first seen 2 days ago)
                                  T-100 $400,000    "SBIR Phase I ..."    -> solicitation O1
    Bravo     uas                 T-5   $50,000     research
                                  T-120 $20,000     research
    Charlie   maritime, swarming  T-3   $5,000,000  "Production and delivery ..."
    Delta     uas                 T-200 $300,000    research
    (none)    not tagged          T-1   $9,000,000  never counted

    solicitation  category  posted  closes  agency
    O1            maritime  T-150   T-100   Navy
    O2            maritime  T-20    T+30    Navy
    O3            maritime  T-40    T+10    Navy
    O4            uas       T-100   T-60    Air Force
    O5            not tagged T-5            never counted
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from pipeline import signals as refresher
from pipeline.api import queries, seed, signals
from pipeline.api.app import app, get_conn

ROOT = queries.taxonomy()["root"]


def _build(db) -> dict:
    today = db.execute("SELECT current_date").fetchone()[0]
    now = datetime.now(UTC)
    ids: dict = {"today": today, "now": now}

    def tag_id(slug: str) -> int:
        return db.execute(
            """INSERT INTO tags (slug, source, source_id) VALUES (%s, 'taxonomy', %s)
               ON CONFLICT (source, source_id) DO UPDATE SET slug = EXCLUDED.slug RETURNING id""",
            (slug, slug),
        ).fetchone()[0]

    tags = {s: tag_id(s) for s in [ROOT, "maritime", "uas", "swarming"]}

    def tag(kind: str, entity_id: int, slugs: list[str]) -> None:
        for slug in [ROOT, *slugs]:
            db.execute(
                """INSERT INTO taggings (entity_type, entity_id, tag_id, source, source_id)
                   VALUES (%s, %s, %s, 'test', %s)""",
                (kind, entity_id, tags[slug], f"{kind}:{entity_id}:{slug}"),
            )

    def org(name: str, kind: str) -> int:
        return db.execute(
            """INSERT INTO organizations (canonical_name, kind, source, source_id)
               VALUES (%s, %s, 'test', %s) RETURNING id""",
            (name, kind, name),
        ).fetchone()[0]

    for name, kind in [
        ("Navy", "agency"),
        ("Air Force", "agency"),
        ("Alpha", "company"),
        ("Bravo", "company"),
        ("Charlie", "company"),
        ("Delta", "company"),
    ]:
        ids[name] = org(name, kind)

    def opp(key: str, agency: str, posted: int, closes: int | None, slugs: list[str] | None):
        (oid,) = db.execute(
            """INSERT INTO opportunities (title, agency_id, posted_at, closes_at, source, source_id)
               VALUES (%s, %s, %s, %s, 'test', %s) RETURNING id""",
            (
                key,
                ids[agency],
                today - timedelta(days=posted),
                today - timedelta(days=closes) if closes is not None else None,
                key,
            ),
        ).fetchone()
        if slugs is not None:
            tag("opportunity", oid, slugs)
        ids[key] = oid

    opp("O1", "Navy", 150, 100, ["maritime"])
    opp("O2", "Navy", 20, -30, ["maritime"])
    opp("O3", "Navy", 40, -10, ["maritime"])
    opp("O4", "Air Force", 100, 60, ["uas"])
    opp("O5", "Air Force", 5, None, None)

    def award(
        key: str,
        company: str | None,
        agency: str,
        age: int,
        amount: int,
        text: str,
        slugs: list[str] | None,
        *,
        opportunity: str | None = None,
        seen_days_ago: int = 30,
    ) -> None:
        (aid,) = db.execute(
            """INSERT INTO awards (recipient_id, agency_id, amount, signed_at, description,
                                   opportunity_id, source, source_id, first_seen_at)
               VALUES (%s, %s, %s, %s, %s, %s, 'test', %s, %s) RETURNING id""",
            (
                ids[company] if company else None,
                ids[agency],
                amount,
                today - timedelta(days=age),
                text,
                ids[opportunity] if opportunity else None,
                key,
                now - timedelta(days=seen_days_ago),
            ),
        ).fetchone()
        if slugs is not None:
            tag("award", aid, slugs)
        ids[key] = aid

    award("a2", "Alpha", "Navy", 10, 1_000_000, "SBIR Phase II prototype", ["maritime"],
          seen_days_ago=2)  # fmt: skip
    award("a1", "Alpha", "Navy", 100, 400_000, "SBIR Phase I study", ["maritime"],
          opportunity="O1")  # fmt: skip
    award("b2", "Bravo", "Air Force", 5, 50_000, "Research and development", ["uas"])
    award("b1", "Bravo", "Air Force", 120, 20_000, "Research and development", ["uas"])
    award("c1", "Charlie", "Navy", 3, 5_000_000, "Production and delivery of vessels",
          ["maritime", "swarming"])  # fmt: skip
    award("d1", "Delta", "Air Force", 200, 300_000, "Research and development", ["uas"])
    award("x1", None, "Navy", 1, 9_000_000, "Destroyer maintenance", None)
    db.commit()
    refresher.refresh(db)
    return ids


@pytest.fixture
def world(db):
    ids = _build(db)
    app.dependency_overrides[get_conn] = lambda: db
    yield TestClient(app), db, ids
    app.dependency_overrides.clear()


def get(client: TestClient, path: str, **params) -> dict:
    r = client.get(f"/api/signals/{path}", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def names(body: dict) -> list[str]:
    return [i["org"]["name"] for i in body["items"]]


def _tag(db, kind: str, entity_id: int, slugs: tuple[str, ...]) -> None:
    for slug in (ROOT, *slugs):
        db.execute(
            """INSERT INTO taggings (entity_type, entity_id, tag_id, source, source_id)
               SELECT %s, %s, id, 'test', %s FROM tags WHERE slug = %s""",
            (kind, entity_id, f"{kind}:{entity_id}:{slug}", slug),
        )


def add_award(db, ids, key, company, agency, age, amount, text, slugs=()) -> None:
    """One more autonomy award on top of the fixture, for the sorting tests:
    with only the fixture's rows, most columns put the rows in the same order."""
    (aid,) = db.execute(
        """INSERT INTO awards (recipient_id, agency_id, amount, signed_at, description,
                               source, source_id)
           VALUES (%s, %s, %s, %s, %s, 'test', %s) RETURNING id""",
        (
            ids[company] if company else None,
            ids[agency],
            amount,
            ids["today"] - timedelta(days=age),
            text,
            key,
        ),
    ).fetchone()
    _tag(db, "award", aid, slugs)


def add_opp(db, ids, key, agency, posted, closes=None, slugs=()) -> None:
    """One more autonomy solicitation; `posted` and `closes` are days ago."""
    (oid,) = db.execute(
        """INSERT INTO opportunities (title, agency_id, posted_at, closes_at, source, source_id)
           VALUES (%s, %s, %s, %s, 'test', %s) RETURNING id""",
        (
            key,
            ids[agency],
            ids["today"] - timedelta(days=posted),
            ids["today"] - timedelta(days=closes) if closes is not None else None,
            key,
        ),
    ).fetchone()
    _tag(db, "opportunity", oid, slugs)


def test_every_response_says_when_and_from_what(world):
    client, _, ids = world
    for path in [
        "overview",
        "funding",
        "momentum",
        "new-entrants",
        "transitions",
        "transitions/companies",
        "topics",
        "largest-awards",
        "agencies",
        "categories/series",
    ]:
        body = get(client, path)
        assert body["as_of"] == str(ids["today"]), path
        assert body["window_days"] == 90
        assert body["sources"] and set(body["sources"]) <= {
            "awards",
            "opportunities",
            "taggings",
            "tags",
            "organizations",
        }
        assert body["sample"] is False
        # Awards start at T-200: enough for a 90-day prior period, not a 365-day
        # one. Solicitations start at T-150, inside the prior period (it opens at
        # T-179), so solicitation counts have no full prior period to compare with.
        # The topics endpoint counts only solicitations and is judged by them.
        assert body["coverage"] == {
            "first_award_day": str(ids["today"] - timedelta(days=200)),
            "prior_complete": path != "topics",
            "first_solicitation_day": str(ids["today"] - timedelta(days=150)),
            "solicitations_prior_complete": False,
        }, path
    assert get(client, "overview", window=365)["coverage"]["prior_complete"] is False
    month = get(client, "topics", window=30)["coverage"]
    assert month["prior_complete"] is True and month["solicitations_prior_complete"] is True


def test_overview_headline_figures(world):
    client, _, _ = world
    o = get(client, "overview")
    assert (o["amount"], o["awards"]) == (6_050_000, 3)  # the untagged $9M is not in it
    assert (o["prev_amount"], o["prev_awards"]) == (420_000, 2)
    assert (o["new_entrants"], o["prev_new_entrants"]) == (1, 2)  # Charlie; Alpha and Bravo
    assert (o["open_solicitations"], o["prev_open_solicitations"]) == (2, 1)  # O2, O3; O4
    assert (o["posted"], o["prev_posted"]) == (2, 2)

    m = get(client, "overview", tag="maritime")
    assert (m["amount"], m["prev_amount"], m["new_entrants"]) == (6_000_000, 400_000, 1)
    assert get(client, "overview", tag="uas")["amount"] == 50_000
    assert get(client, "overview", window=30)["awards"] == 3
    assert get(client, "overview", window=365)["amount"] == 6_770_000


def _family_tags(db) -> None:
    """The rest of the taxonomy's tags, so awards can be tagged with any of them."""
    for slug in queries.taxonomy()["tags"]:
        db.execute(
            """INSERT INTO tags (slug, source, source_id) VALUES (%s, 'taxonomy', %s)
               ON CONFLICT (source, source_id) DO NOTHING""",
            (slug, slug),
        )


def test_money_by_family_parts_add_up_to_the_awarded_total(world):
    client, db, ids = world
    # The fixture alone: Alpha $1M maritime, Bravo $50K uas, and Charlie's $5M
    # tagged maritime and swarming, which is half maritime and half aerial.
    m = get(client, "overview")["money_by_family"]
    order = ["aerial", "maritime", "navigation", "counter", "other", "uncategorized"]
    assert [i["family"] for i in m["items"]] == order
    by = {i["family"]: i for i in m["items"]}
    assert m["total"] == 6_050_000
    assert (by["aerial"]["amount"], by["aerial"]["awards"]) == (2_550_000, 2)
    assert (by["maritime"]["amount"], by["maritime"]["awards"]) == (3_500_000, 2)
    assert all(by[f]["amount"] == 0 and by[f]["awards"] == 0 for f in order[2:])
    assert by["uncategorized"]["tags"] == []
    assert by["aerial"]["label"] == "Aerial" and by["aerial"]["covers"].startswith("Drones")

    _family_tags(db)
    add = lambda key, amount, slugs: add_award(  # noqa: E731
        db, ids, key, "Bravo", "Air Force", 8, amount, "Research and development", slugs
    )
    add("same", 300_000, ("uas", "swarming"))  # two tags, one family
    add("two", 100_000.01, ("uas", "counter-uas"))  # two families
    add("three", 100_000, ("gps-denied-nav", "ground-robotics", "uxs-c2", "loitering-munitions"))
    add("none", 70_000, ())  # autonomy, but no category tag
    # In the prior period, so not in the 90-day split.
    add_award(db, ids, "old", "Bravo", "Air Force", 95, 999_999, "Research", ("maritime",))
    db.commit()
    refresher.refresh(db)

    o = get(client, "overview")
    m = o["money_by_family"]
    by = {i["family"]: i for i in m["items"]}
    assert [i["family"] for i in m["items"]] == order
    # The parts add up to the Awarded figure, to the cent.
    assert o["amount"] == pytest.approx(6_620_000.01, abs=0.001)
    assert m["total"] == pytest.approx(o["amount"], abs=0.01)
    assert sum(i["amount"] for i in m["items"]) == pytest.approx(o["amount"], abs=0.01)
    assert sum(i["share"] for i in m["items"]) == pytest.approx(1)
    third = 100_000 / 3
    assert by["aerial"]["amount"] == pytest.approx(2_550_000 + 300_000 + 50_000.005 + third)
    assert by["maritime"]["amount"] == pytest.approx(3_500_000)
    assert by["navigation"]["amount"] == pytest.approx(third)
    assert by["counter"]["amount"] == pytest.approx(50_000.005)
    assert by["other"]["amount"] == pytest.approx(third)
    assert by["uncategorized"]["amount"] == 70_000
    # An award counts once in each family it touches.
    assert {f: by[f]["awards"] for f in order} == {
        "aerial": 5,  # Bravo, Charlie, same, two, three
        "maritime": 2,
        "navigation": 1,
        "counter": 1,
        "other": 1,
        "uncategorized": 1,
    }
    assert sum(i["awards"] for i in m["items"]) > o["awards"] == 7

    # Inside a family, its tags add up to it, in the taxonomy's order.
    fams = {f["key"]: f["tags"] for f in queries.families()}
    for i in m["items"][:-1]:
        assert [t["tag"] for t in i["tags"]] == fams[i["family"]]
        assert sum(t["amount"] for t in i["tags"]) == pytest.approx(i["amount"], abs=0.01)
        if i["amount"]:
            assert sum(t["share"] for t in i["tags"]) == pytest.approx(1)
    aerial = {t["tag"]: t for t in by["aerial"]["tags"]}
    # uas: Bravo's $50K, half of "same", and its family's half of "two".
    assert aerial["uas"]["amount"] == pytest.approx(50_000 + 150_000 + 50_000.005)
    assert aerial["swarming"]["amount"] == pytest.approx(2_500_000 + 150_000)
    assert aerial["loitering-munitions"]["amount"] == pytest.approx(third)
    assert aerial["collaborative-combat-aircraft"] == {
        "tag": "collaborative-combat-aircraft",
        "amount": 0,
        "share": 0,
        "awards": 0,
    }
    assert (aerial["uas"]["awards"], aerial["swarming"]["awards"]) == (3, 2)
    other = {t["tag"]: t for t in by["other"]["tags"]}
    # "three" has two tags in this family: each takes half of the family's third.
    assert other["ground-robotics"]["amount"] == pytest.approx(third / 2)
    assert other["uxs-c2"]["amount"] == pytest.approx(third / 2)
    assert other["autonomy-software"]["amount"] == 0

    # The category filter narrows the headline figures, never this split.
    filtered = get(client, "overview", tag="maritime")
    assert filtered["amount"] == 6_000_000
    assert filtered["money_by_family"] == m
    # Each window has its own split, and each adds up to its own total.
    for window in (30, 365):
        w = get(client, "overview", window=window)
        parts = sum(i["amount"] for i in w["money_by_family"]["items"])
        assert parts == pytest.approx(w["amount"], abs=0.01)
        assert w["money_by_family"]["total"] == pytest.approx(w["amount"], abs=0.01)
    assert get(client, "overview", window=365)["money_by_family"]["total"] > m["total"]


def test_every_tag_is_in_exactly_one_family():
    tax = queries.taxonomy()
    fams = queries.families()
    assert [f["key"] for f in fams] == ["aerial", "maritime", "navigation", "counter", "other"]
    assert all(f["label"] and f["covers"] and f["tags"] for f in fams)
    assert sorted(t for f in fams for t in f["tags"]) == sorted(tax["tags"])
    assert queries.family_of()["uas"] == "aerial"
    assert set(queries.family_of()) == set(tax["tags"])

    def broken(change) -> dict:
        copy = {
            **tax,
            "families": {k: {**f, "tags": list(f["tags"])} for k, f in tax["families"].items()},
        }
        change(copy["families"])
        return copy

    with pytest.raises(ValueError, match="in no family"):
        queries.check_families(broken(lambda f: f["maritime"]["tags"].clear()))
    with pytest.raises(ValueError, match="in two families"):
        queries.check_families(broken(lambda f: f["other"]["tags"].append("uas")))
    with pytest.raises(ValueError, match="unknown tag"):
        queries.check_families(broken(lambda f: f["other"]["tags"].append("submarines")))
    with pytest.raises(ValueError, match="in no family"):
        queries.check_families({**tax, "families": None})


def test_funding_by_company_ranks_and_filters(world):
    client, _, _ = world
    f = get(client, "funding")
    assert [(i["org"]["name"], i["amount"], i["rank"], i["prev_rank"]) for i in f["items"]] == [
        ("Charlie", 5_000_000, 1, None),
        ("Alpha", 1_000_000, 2, 1),
        ("Bravo", 50_000, 3, 2),
    ]
    assert f["total"] == 3 and f["by"] == "company"
    assert f["items"][0]["org"]["tag"] == "maritime"  # ties broken by slug

    page = get(client, "funding", limit=1, offset=1)
    assert [i["org"]["name"] for i in page["items"]] == ["Alpha"]
    assert (page["total"], page["limit"], page["offset"]) == (3, 1, 1)

    sw = get(client, "funding", tag="swarming")
    assert [(i["org"]["name"], i["rank"]) for i in sw["items"]] == [("Charlie", 1)]

    by_name = get(client, "funding", sort="name", order="asc")
    assert [i["org"]["name"] for i in by_name["items"]] == ["Alpha", "Bravo", "Charlie"]


def test_funding_by_agency_and_category(world):
    client, _, _ = world
    ag = get(client, "funding", by="agency")
    assert [(i["org"]["name"], i["amount"], i["awards"]) for i in ag["items"]] == [
        ("Navy", 6_000_000, 2),
        ("Air Force", 50_000, 1),
    ]
    cat = get(client, "funding", by="category")
    # Charlie's award has two tags, so it counts in both: categories sum past the total.
    assert [(i["category"], i["amount"], i["rank"]) for i in cat["items"]] == [
        ("maritime", 6_000_000, 1),
        ("swarming", 5_000_000, 2),
        ("uas", 50_000, 3),
    ]
    assert all(i["org"] is None for i in cat["items"])


def test_momentum_leaves_tiny_baselines_out_of_percentages(world):
    client, _, _ = world
    m = get(client, "momentum")
    # Only Alpha has a prior period of $100,000 or more.
    assert [(i["org"]["name"], i["delta"], i["pct"]) for i in m["items"]] == [
        ("Alpha", 600_000, 1.5)
    ]
    assert m["min_baseline"] == signals.MIN_BASELINE == 100_000

    by_dollars = get(client, "momentum", sort="delta")
    assert [(i["org"]["name"], i["delta"], i["pct"]) for i in by_dollars["items"]] == [
        ("Charlie", 5_000_000, None),
        ("Alpha", 600_000, 1.5),
        ("Bravo", 30_000, None),  # $20,000 before: a change in dollars, no percentage
    ]
    cats = get(client, "momentum", by="category", sort="delta")
    assert [i["category"] for i in cats["items"]] == ["maritime", "swarming", "uas"]
    assert cats["items"][0]["pct"] == 14.0  # 400k -> 6M
    # Delta's only award is 200 days old: outside both periods, so not a "faller".
    assert get(client, "momentum", sort="delta", direction="falling")["items"] == []
    year = get(client, "momentum", window=365, sort="delta", direction="all")
    assert {i["org"]["name"] for i in year["items"]} == {"Alpha", "Bravo", "Charlie", "Delta"}


def test_momentum_order_can_be_reversed(world):
    client, _, _ = world
    # Biggest rise first unless asked otherwise.
    assert names(get(client, "momentum", sort="delta")) == ["Charlie", "Alpha", "Bravo"]
    assert names(get(client, "momentum", sort="delta", order="desc")) == [
        "Charlie",
        "Alpha",
        "Bravo",
    ]
    assert names(get(client, "momentum", sort="delta", order="asc")) == [
        "Bravo",
        "Alpha",
        "Charlie",
    ]
    # Reversing the order does not bring tiny baselines back into the percentages.
    assert names(get(client, "momentum", sort="pct", order="asc")) == ["Alpha"]
    assert get(client, "momentum", sort="delta", direction="falling", order="desc")["items"] == []


def test_new_entrants(world):
    client, _, ids = world
    e = get(client, "new-entrants")
    assert [(i["org"]["name"], i["first_amount"], i["tags"]) for i in e["items"]] == [
        ("Charlie", 5_000_000, ["maritime", "swarming"])
    ]
    assert e["items"][0]["first_day"] == str(ids["today"] - timedelta(days=3))
    assert get(client, "new-entrants", tag="uas")["items"] == []
    year = get(client, "new-entrants", window=365)
    assert [i["org"]["name"] for i in year["items"]] == ["Charlie", "Alpha", "Delta", "Bravo"]


def test_new_entrants_sorting(world):
    """Over a year all four companies are new:

    company  first award  first-day dollars  total       awards
    Alpha    T-100        $400,000           $1,400,000  2
    Bravo    T-120        $20,000            $70,000     2
    Charlie  T-3          $5,000,000         $5,000,000  1
    Delta    T-200        $300,000           $300,000    1
    """
    client, db, ids = world

    def order(**params) -> list[str]:
        return names(get(client, "new-entrants", window=365, **params))

    assert order() == order(sort="amount", order="desc") == ["Charlie", "Alpha", "Delta", "Bravo"]
    assert order(sort="amount", order="asc") == ["Bravo", "Delta", "Alpha", "Charlie"]
    assert order(sort="first_day") == ["Charlie", "Alpha", "Bravo", "Delta"]  # newest first
    assert order(sort="first_day", order="asc") == ["Delta", "Bravo", "Alpha", "Charlie"]
    assert order(sort="first_amount") == ["Charlie", "Alpha", "Delta", "Bravo"]
    assert order(sort="first_amount", order="asc") == ["Bravo", "Delta", "Alpha", "Charlie"]
    # Equal award counts fall back to total dollars, largest first.
    assert order(sort="awards") == ["Alpha", "Bravo", "Charlie", "Delta"]
    assert order(sort="awards", order="asc") == ["Charlie", "Delta", "Alpha", "Bravo"]
    assert order(sort="name", order="asc") == ["Alpha", "Bravo", "Charlie", "Delta"]
    assert order(sort="name", order="desc") == ["Delta", "Charlie", "Bravo", "Alpha"]
    # Sorting happens before paging.
    assert order(sort="name", order="asc", limit=2, offset=1) == ["Bravo", "Charlie"]

    # A second award takes Delta to two awards and $6,300,000: among the three
    # companies with two awards, the one with the most dollars leads.
    add_award(db, ids, "d2", "Delta", "Air Force", 50, 6_000_000, "Research and development")
    db.commit()
    refresher.refresh(db)
    assert order(sort="awards") == ["Delta", "Alpha", "Bravo", "Charlie"]
    assert order(sort="awards", order="asc") == ["Charlie", "Delta", "Alpha", "Bravo"]


def test_transitions_and_entries(world):
    client, _, ids = world
    t = get(client, "transitions")
    assert len(t["items"]) == 1
    row = t["items"][0]
    assert (row["org"]["name"], row["from_stage"], row["to_stage"]) == (
        "Alpha",
        "phase_1",
        "phase_2",
    )
    assert row["days_between"] == 90 and row["amount"] == 1_000_000
    assert [(p["stage"], p["day"] is not None) for p in row["path"]] == [
        ("solicitation", True),
        ("phase_1", True),
        ("phase_2", True),
        ("production", False),
    ]
    assert row["path"][0]["day"] == str(ids["today"] - timedelta(days=150))

    # Charlie's first record is a production contract: reached, but no transition.
    assert get(client, "transitions", stage="production")["items"] == []
    entry = get(client, "transitions", stage="production", entries=True)["items"]
    assert [(i["org"]["name"], i["from_stage"], i["days_between"]) for i in entry] == [
        ("Charlie", None, None)
    ]
    # Alpha's Phase I (T-100, after its solicitation) is a transition in the prior quarter.
    year = get(client, "transitions", window=365)
    assert [(i["from_stage"], i["to_stage"], i["days_between"]) for i in year["items"]] == [
        ("phase_1", "phase_2", 90),
        ("solicitation", "phase_1", 50),
    ]

    ranked = get(client, "transitions/companies", window=365)
    assert [
        (i["org"]["name"], i["transitions"], i["stage"], i["days_total"]) for i in ranked["items"]
    ] == [("Alpha", 2, "phase_2", 140)]


def test_transition_companies_sorting(world):
    """Bravo gets two more awards, so two companies have moved between stages:

    company  stages on record                           moves in 90d  on record  first to furthest
    Alpha    solicitation T-150, Phase I T-100,         1             2          140 days
             Phase II T-10
    Bravo    Phase I T-60, production T-20              1             1          40 days
    """
    client, db, ids = world
    add_award(db, ids, "b3", "Bravo", "Air Force", 60, 100_000, "SBIR Phase I study")
    add_award(db, ids, "b4", "Bravo", "Air Force", 20, 900_000, "Production of air vehicles")
    db.commit()
    refresher.refresh(db)

    def order(**params) -> list[str]:
        return names(get(client, "transitions/companies", **params))

    rows = get(client, "transitions/companies")["items"]
    assert [
        (i["org"]["name"], i["transitions"], i["transitions_total"], i["stage"], i["days_total"])
        for i in rows
    ] == [("Alpha", 1, 2, "phase_2", 140), ("Bravo", 1, 1, "production", 40)]
    # One move each in the window: the tie goes to more moves on record.
    assert order(sort="transitions", order="desc") == ["Alpha", "Bravo"]
    assert order(sort="transitions", order="asc") == ["Alpha", "Bravo"]
    assert order(sort="transitions", order="asc", window=365) == ["Bravo", "Alpha"]
    assert order(sort="transitions_total") == ["Alpha", "Bravo"]
    assert order(sort="transitions_total", order="asc") == ["Bravo", "Alpha"]
    assert order(sort="stage") == ["Bravo", "Alpha"]  # production is further than Phase II
    assert order(sort="stage", order="asc") == ["Alpha", "Bravo"]
    assert order(sort="latest_day") == ["Alpha", "Bravo"]
    assert order(sort="latest_day", order="asc") == ["Bravo", "Alpha"]
    assert order(sort="days_total") == ["Alpha", "Bravo"]
    assert order(sort="days_total", order="asc") == ["Bravo", "Alpha"]
    assert order(sort="name", order="asc") == ["Alpha", "Bravo"]
    assert order(sort="name", order="desc") == ["Bravo", "Alpha"]
    assert order(sort="name", order="desc", limit=1, offset=1) == ["Alpha"]


def test_days_total_runs_to_the_furthest_stage_not_the_latest_date(world):
    """Bravo: Phase I T-60, production T-20, and the production award is linked
    to a solicitation posted afterwards (T-5). First stage to furthest is still
    the 40 days from Phase I to production, not the 55 to the solicitation."""
    client, db, ids = world
    add_award(db, ids, "b3", "Bravo", "Air Force", 60, 100_000, "SBIR Phase I study")
    add_award(db, ids, "b4", "Bravo", "Air Force", 20, 900_000, "Production of air vehicles")
    add_opp(db, ids, "late", "Air Force", 5)
    db.execute(
        """UPDATE awards
           SET opportunity_id = (SELECT id FROM opportunities WHERE source_id = 'late')
           WHERE source_id = 'b4'"""
    )
    db.commit()
    refresher.refresh(db)
    rows = get(client, "transitions/companies")["items"]
    assert {i["org"]["name"]: i["days_total"] for i in rows} == {"Alpha": 140, "Bravo": 40}


def test_topic_heat_counts_solicitations(world):
    client, _, _ = world
    t = get(client, "topics")
    assert [
        (i["category"], i["posted"], i["prev_posted"], i["delta"], i["rising"], i["open"])
        for i in t["items"]
    ] == [("maritime", 2, 1, 1, True, 2), ("uas", 0, 1, -1, False, 0)]
    # One prior posting is too few for a percentage.
    assert all(i["pct"] is None for i in t["items"])
    for i in t["items"]:
        assert len(i["series"]) == signals.SERIES_BUCKETS
        assert sum(i["series"]) == i["posted"] + i["prev_posted"]
        half = signals.SERIES_BUCKETS // 2
        assert sum(i["series"][half:]) == i["posted"]
    assert t["bucket_days"] == 15 and t["items"][0]["amount"] == 6_000_000


def test_topics_sorting(world):
    """Three more solicitations, so the columns disagree about the order:

    category  posted  prior  change  open now  award dollars
    maritime  2       1      +1      2         $6,000,000   (O2, O3; O1)
    swarming  1       0      +1      0         $5,000,000   (O8, already closed)
    uas       0       3      -3      1         $50,000      (O4, O6 still open, O7)
    """
    client, db, ids = world
    add_opp(db, ids, "O6", "Air Force", 95, None, ("uas",))
    add_opp(db, ids, "O7", "Air Force", 130, 100, ("uas",))
    add_opp(db, ids, "O8", "Navy", 2, 1, ("swarming",))
    db.commit()
    refresher.refresh(db)

    def order(**params) -> list[str]:
        return [i["category"] for i in get(client, "topics", **params)["items"]]

    t = get(client, "topics")
    assert [
        (i["category"], i["posted"], i["prev_posted"], i["delta"], i["open"], i["amount"])
        for i in t["items"]
    ] == [
        ("maritime", 2, 1, 1, 2, 6_000_000),  # same rise as swarming, more postings
        ("swarming", 1, 0, 1, 0, 5_000_000),
        ("uas", 0, 3, -3, 1, 50_000),
    ]
    assert [i["pct"] for i in t["items"]] == [None, None, -1.0]  # only uas had 3 before
    assert order(sort="delta", order="desc") == ["maritime", "swarming", "uas"]
    assert order(sort="delta", order="asc") == ["uas", "maritime", "swarming"]
    assert order(sort="posted") == ["maritime", "swarming", "uas"]
    assert order(sort="posted", order="asc") == ["uas", "swarming", "maritime"]
    assert order(sort="prev_posted") == ["uas", "maritime", "swarming"]
    assert order(sort="prev_posted", order="asc") == ["swarming", "maritime", "uas"]
    assert order(sort="open") == ["maritime", "uas", "swarming"]
    assert order(sort="open", order="asc") == ["swarming", "uas", "maritime"]
    assert order(sort="amount") == ["maritime", "swarming", "uas"]
    assert order(sort="amount", order="asc") == ["uas", "swarming", "maritime"]
    assert order(sort="category", order="asc") == ["maritime", "swarming", "uas"]
    assert order(sort="category", order="desc") == ["uas", "swarming", "maritime"]
    page = get(client, "topics", sort="prev_posted", limit=1, offset=1)
    assert [i["category"] for i in page["items"]] == ["maritime"] and page["total"] == 3


def test_largest_awards(world):
    client, _, _ = world
    a = get(client, "largest-awards")
    assert [(i["amount"], i["recipient"]["name"], i["agency"]["name"]) for i in a["items"]] == [
        (5_000_000, "Charlie", "Navy"),
        (1_000_000, "Alpha", "Navy"),
        (50_000, "Bravo", "Air Force"),
    ]
    assert [i["stage"] for i in a["items"]] == ["production", "phase_2", None]
    assert [i["amount"] for i in get(client, "largest-awards", tag="uas")["items"]] == [50_000]


def test_agency_appetite_and_mix(world):
    client, _, _ = world
    a = get(client, "agencies")
    navy, air_force = a["items"]
    assert (navy["org"]["name"], navy["amount"], navy["awards"], navy["posted"]) == (
        "Navy",
        6_000_000,
        2,
        2,
    )
    assert navy["mix"] == [
        {"category": "maritime", "amount": 6_000_000, "awards": 2, "posted": 2},
        {"category": "swarming", "amount": 5_000_000, "awards": 1, "posted": 0},
    ]
    assert (air_force["org"]["name"], air_force["posted"], air_force["prev_posted"]) == (
        "Air Force",
        0,
        1,
    )
    by_posted = get(client, "agencies", sort="posted")
    assert by_posted["items"][0]["org"]["name"] == "Navy"


def test_agencies_sorting(world):
    """More rows for both agencies, so the columns disagree about the order:

    agency     dollars     awards  posted  prior dollars  change
    Navy       $6,000,000  2       2       $6,300,000     -$300,000  (a $5.9M award at T-100)
    Air Force  $52,000     3       3       $20,000        +$32,000   (two $1,000 awards, 3 postings)
    """
    client, db, ids = world
    add_award(db, ids, "n1", None, "Navy", 100, 5_900_000, "Research and development")
    add_award(db, ids, "f1", None, "Air Force", 7, 1_000, "Research and development")
    add_award(db, ids, "f2", None, "Air Force", 7, 1_000, "Research and development")
    for key in ("P1", "P2", "P3"):
        add_opp(db, ids, key, "Air Force", 10)
    db.commit()
    refresher.refresh(db)

    def order(**params) -> list[str]:
        return names(get(client, "agencies", **params))

    a = get(client, "agencies")
    assert [
        (i["org"]["name"], i["amount"], i["awards"], i["posted"], i["delta"]) for i in a["items"]
    ] == [("Navy", 6_000_000, 2, 2, -300_000), ("Air Force", 52_000, 3, 3, 32_000)]
    assert order(sort="amount", order="desc") == ["Navy", "Air Force"]
    assert order(sort="amount", order="asc") == ["Air Force", "Navy"]
    assert order(sort="awards") == ["Air Force", "Navy"]
    assert order(sort="awards", order="asc") == ["Navy", "Air Force"]
    assert order(sort="posted") == ["Air Force", "Navy"]
    assert order(sort="posted", order="asc") == ["Navy", "Air Force"]
    assert order(sort="delta") == ["Air Force", "Navy"]
    assert order(sort="delta", order="asc") == ["Navy", "Air Force"]
    assert order(sort="name", order="asc") == ["Air Force", "Navy"]
    assert order(sort="name", order="desc") == ["Navy", "Air Force"]
    assert order(sort="name", order="desc", limit=1, offset=1) == ["Air Force"]


def test_category_series_adds_up(world):
    client, _, ids = world
    s = get(client, "categories/series")
    assert [i["category"] for i in s["items"]] == ["maritime", "swarming", "uas"]
    for i in s["items"]:
        assert len(i["series"]) == signals.SERIES_BUCKETS
        assert sum(i["series"]) == i["amount"] + i["prev_amount"]
    assert s["series_start"] == str(ids["today"] - timedelta(days=179))


def test_watchlist_reports_what_first_appeared_since_the_last_visit(world):
    client, _, ids = world
    since = (ids["now"] - timedelta(days=5)).isoformat()
    w = get(client, "watchlist", ids=f"{ids['Alpha']},{ids['Bravo']},{ids['Navy']}", since=since)
    alpha, bravo, navy = w["items"]
    # Alpha's Phase II award entered the data two days ago; the rest was there before.
    assert [a["id"] for a in alpha["new_awards"]] == [ids["a2"]]
    assert alpha["new_amount"] == 1_000_000
    assert [s["stage"] for s in alpha["new_stages"]] == ["phase_2"]
    assert (alpha["rank"], alpha["rank_then"], alpha["days_since_last"]) == (2, None, 10)
    assert bravo["new_awards"] == [] and bravo["new_stages"] == []
    assert (bravo["rank"], bravo["rank_then"]) == (3, 1)
    assert [a["id"] for a in navy["new_awards"]] == [ids["a2"]]
    assert navy["rank"] == 1 and navy["rank_then"] is None

    first_visit = get(client, "watchlist", ids=str(ids["Alpha"]))
    assert first_visit["since"] is None
    assert first_visit["items"][0]["new_awards"] == []
    assert get(client, "watchlist", ids="999999")["items"] == []
    assert client.get("/api/signals/watchlist", params={"ids": "abc"}).status_code == 422


def test_org_signals(world):
    client, _, ids = world
    a = get(client, f"orgs/{ids['Alpha']}")
    assert (a["amount"], a["prev_amount"], a["delta"], a["pct"]) == (
        1_000_000,
        400_000,
        600_000,
        1.5,
    )
    assert (a["rank"], a["prev_rank"]) == (2, 1)
    assert (a["category"], a["category_rank"], a["category_prev_rank"]) == ("maritime", 2, 1)
    assert (a["stage"], a["days_since_last"]) == ("phase_2", 10)

    navy = get(client, f"orgs/{ids['Navy']}")
    assert (navy["rank"], navy["stage"], navy["days_since_last"]) == (1, None, 3)
    assert all(p["day"] is None for p in navy["path"])
    assert client.get("/api/signals/orgs/999999").status_code == 404


def test_bad_parameters_are_rejected(world):
    client, _, _ = world
    assert client.get("/api/signals/funding", params={"window": 45}).status_code == 422
    assert client.get("/api/signals/funding", params={"tag": "no-such-tag"}).status_code == 422
    assert client.get("/api/signals/funding", params={"sort": "id; drop"}).status_code == 422
    assert client.get("/api/signals/funding", params={"limit": 0}).status_code == 422
    assert client.get("/api/signals/funding", params={"by": "program"}).status_code == 422
    # Sort columns come from a fixed list on every endpoint; anything else is refused.
    for path in ["momentum", "new-entrants", "transitions/companies", "topics", "agencies"]:
        url = f"/api/signals/{path}"
        assert client.get(url, params={"sort": "id; drop"}).status_code == 422, path
        assert client.get(url, params={"sort": "org_id"}).status_code == 422, path
        assert client.get(url, params={"order": "sideways"}).status_code == 422, path


def test_an_empty_database_gives_empty_answers_not_errors(db):
    refresher.refresh(db)
    app.dependency_overrides[get_conn] = lambda: db
    try:
        client = TestClient(app)
        o = get(client, "overview")
        assert (o["amount"], o["awards"], o["new_entrants"], o["open_solicitations"]) == (
            0,
            0,
            0,
            0,
        )
        assert o["coverage"] == {
            "first_award_day": None,
            "prior_complete": False,
            "first_solicitation_day": None,
            "solicitations_prior_complete": False,
        }
        for path in ["funding", "momentum", "new-entrants", "transitions", "topics", "agencies"]:
            assert get(client, path)["items"] == []
        assert get(client, "categories/series")["items"] == []
        assert o["money_by_family"]["total"] == 0
        assert [(i["amount"], i["share"], i["awards"]) for i in o["money_by_family"]["items"]] == [
            (0, 0, 0)
        ] * 6
        assert client.get("/api/summary").json()["awards_30d"] == 0
        assert client.get("/api/digest").json()["awards"] == 0
    finally:
        app.dependency_overrides.clear()


def test_signals_are_stale_until_refreshed_and_refresh_is_repeatable(world):
    client, db, ids = world
    db.execute(
        """INSERT INTO awards (recipient_id, agency_id, amount, signed_at, source, source_id)
           VALUES (%s, %s, 1000000, current_date, 'test', 'late')""",
        (ids["Bravo"], ids["Air Force"]),
    )
    (aid,) = db.execute("SELECT id FROM awards WHERE source_id = 'late'").fetchone()
    (root,) = db.execute("SELECT id FROM tags WHERE slug = %s", (ROOT,)).fetchone()
    db.execute(
        """INSERT INTO taggings (entity_type, entity_id, tag_id, source, source_id)
           VALUES ('award', %s, %s, 'test', 'late')""",
        (aid, root),
    )
    db.commit()
    assert get(client, "overview")["amount"] == 6_050_000  # the snapshot, until the nightly step
    counts = refresher.refresh(db)
    assert counts == refresher.refresh(db)
    assert get(client, "overview")["amount"] == 7_050_000


def test_the_dashboard_and_the_other_pages_agree(db):
    """The hero, the field report and the dashboard read the same rows."""
    seed.seed(db)
    app.dependency_overrides[get_conn] = lambda: db
    try:
        client = TestClient(app)
        month = get(client, "overview", window=30)
        summary = client.get("/api/summary").json()
        assert (summary["awards_30d"], summary["amount_30d"]) == (month["awards"], month["amount"])
        assert summary["open_opportunities"] == month["open_solicitations"]

        week = get(client, "overview", window=7)
        digest = client.get("/api/digest").json()
        assert (digest["awards"], digest["amount"]) == (week["awards"], week["amount"])
        assert (digest["prev_awards"], digest["prev_amount"]) == (
            week["prev_awards"],
            week["prev_amount"],
        )
        top = get(client, "largest-awards", window=7, limit=5)
        assert [a["id"] for a in digest["top"]] == [a["id"] for a in top["items"]]
        assert digest["through"] == week["as_of"]

        # The seed plants every kind of row, so no panel is empty on sample data.
        for path in ["momentum", "new-entrants", "topics", "agencies", "largest-awards"]:
            assert get(client, path)["items"], path
        assert get(client, "transitions", window=365)["items"]
        assert get(client, "overview")["sample"] is True

        # "Where the money went" adds up to the Awarded figure in every window.
        for window in signals.WINDOWS:
            o = get(client, "overview", window=window)
            parts = o["money_by_family"]["items"]
            assert sum(i["amount"] for i in parts) == pytest.approx(o["amount"], abs=0.01)
            assert o["money_by_family"]["total"] == pytest.approx(o["amount"], abs=0.01)
        assert sum(i["amount"] > 0 for i in parts) >= 4, "the sample data spans the families"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "text",
    [
        "SBIR Phase I: feasibility study",
        "SBIR Phase II prototype",
        "STTR phase 2 award",
        "phase1 kickoff",
        "Phase III production",
        "Full-rate production of air vehicles",
        "Low-rate initial production lot 3",
        "LRIP lot 4",
        "Procurement of spares",
        "Reproduction services",
        "Research and development",
        "Emphasis on phase iiia testing",
        "",
        None,
    ],
)
def test_sql_and_python_read_the_same_stage(db, text):
    """The view's regexes and queries._stage_of must never drift apart."""
    (aid,) = db.execute(
        """INSERT INTO awards (description, source, source_id) VALUES (%s, 'test', 'stage')
           RETURNING id""",
        (text,),
    ).fetchone()
    (root,) = db.execute(
        """INSERT INTO tags (slug, source, source_id) VALUES (%s, 'taxonomy', %s) RETURNING id""",
        (ROOT, ROOT),
    ).fetchone()
    db.execute(
        """INSERT INTO taggings (entity_type, entity_id, tag_id, source, source_id)
           VALUES ('award', %s, %s, 'test', 'stage')""",
        (aid, root),
    )
    (stage,) = db.execute("SELECT stage FROM autonomy_awards WHERE id = %s", (aid,)).fetchone()
    assert stage == queries._stage_of(text)


def test_the_views_use_the_taxonomy_root():
    sql = (refresher.db.MIGRATIONS_DIR / "007_signals.sql").read_text()
    assert f"g.slug = '{ROOT}'" in sql and f"g.slug <> '{ROOT}'" in sql
    assert f">= {signals.MIN_BASELINE} THEN" in sql
    assert f"ARRAY[{', '.join(str(w) for w in signals.WINDOWS)}]" in sql


def test_definitions_cover_every_signal(world):
    client, _, ids = world
    d = get(client, "definitions")
    assert {i["key"] for i in d["items"]} >= {
        "funding",
        "momentum",
        "new_entrants",
        "transitions",
        "topics",
        "largest_awards",
        "agencies",
        "watchlist",
        "money_by_family",
    }
    assert all(i["text"] and i["tables"] for i in d["items"])
    # The families, for the site: it keeps no copy of the tag-to-family table.
    assert d["families"] == queries.families()
    assert [f["key"] for f in d["families"]] == [
        "aerial",
        "maritime",
        "navigation",
        "counter",
        "other",
    ]
    assert (d["awards"], d["opportunities"]) == (6, 4)
    assert d["as_of"] == str(date.fromisoformat(str(ids["today"])))
