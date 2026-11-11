import pytest

from pipeline.resolve import apply, candidates
from pipeline.resolve.models import CandidatePair, MergeDecision
from tests.resolve_helpers import award, edge, org


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("The Boeing Company", "boeing"),
        ("Smith & Wesson, Inc.", "smith wesson"),
        ("ACME ROBOTICS L.L.C.", "acme robotics"),
        ("General Electric Co., GE Edison Works", "general electric ge edison works"),
        ("O'Neil Corp", "oneil"),
        ("Company Inc.", "company inc"),  # nothing but suffixes: keep the tokens
    ],
)
def test_normalize_name(raw, expected):
    assert candidates.normalize_name(raw) == expected


def test_similarity_and_prefix():
    assert candidates.name_similarity("Anduril Industries, Inc.", "ANDURIL INDUSTRIES INC") == 1.0
    assert candidates.name_similarity("Shield AI", "Skydio") < 0.5
    lm = "Lockheed Martin Corp."
    assert candidates.is_token_prefix(lm, "Lockheed Martin Corp., Missiles and Fire Control")
    assert not candidates.is_token_prefix(lm, "LOCKHEED MARTIN CORPORATION")  # equal, not a prefix
    assert not candidates.is_token_prefix("Boeing Co.", "Boeing Sikorsky Aircraft Support")


pytestmark_db = pytest.mark.db


@pytestmark_db
def test_uei_auto_merge_picks_usaspending_row_then_lowest_id(db):
    dod = org(db, "Leidos Inc.", uei="UE9QJD4KK1L6", source="dod_contracts")
    usa = org(
        db, "LEIDOS, INC.", uei="UE9QJD4KK1L6", source="usaspending", source_id="uei:UE9QJD4KK1L6"
    )
    third = org(db, "Leidos", uei="ue9qjd4kk1l6", source="other")
    a = org(db, "Acme One", uei="AAAAAAAAAAAA", source="x")
    b = org(db, "Acme 1", uei="AAAAAAAAAAAA", source="y")
    org(db, "Loner", uei="BBBBBBBBBBBB")
    org(db, "Agency", uei="UE9QJD4KK1L6", kind="agency")  # not a company

    autos = candidates.uei_auto_merges(db)
    assert autos == [
        candidates.AutoMerge(a, b, "AAAAAAAAAAAA"),  # no usaspending row: lowest id survives
        candidates.AutoMerge(usa, dod, "UE9QJD4KK1L6"),
        candidates.AutoMerge(usa, third, "UE9QJD4KK1L6"),
    ]
    # Same-UEI rows are never sent to the agent.
    assert candidates.name_pairs(db, limit=10) == []


@pytestmark_db
def test_name_pairs_signals_order_and_cap(db):
    lm = org(db, "Lockheed Martin Corp.", uei="ZFN2JJXBLZT3")
    mfc = org(db, "Lockheed Martin Corp., Missiles and Fire Control")
    and1 = org(db, "Anduril Industries, Inc.")
    and2 = org(db, "ANDURIL INDUSTRIES INC", uei="CCCCCCCCCCCC")
    sk1 = org(db, "Skydio Inc", uei="DDDDDDDDDDDD")
    sk2 = org(db, "Skydio, Inc", uei="EEEEEEEEEEEE")
    org(db, "Shield AI")  # nothing similar

    pairs = candidates.name_pairs(db, limit=10)
    assert [(p.left_org_id, p.right_org_id) for p in pairs] == [
        (and1, and2),  # score 1.0
        (sk1, sk2),  # score 1.0, higher ids
        (lm, mfc),  # prefix score 0.9
    ]
    assert all(p.left_org_id < p.right_org_id for p in pairs)
    by = {(p.left_org_id, p.right_org_id): p for p in pairs}
    assert by[(and1, and2)].signals == {
        "name_similarity": 1.0,
        "name_prefix": False,
        "alias_overlap": True,
        "different_ueis": False,
        "same_state": None,
        "shared_parent": None,
    }
    assert by[(sk1, sk2)].signals["different_ueis"] is True  # still sent, as a hint
    assert by[(lm, mfc)].signals["name_prefix"] is True
    assert by[(lm, mfc)].signals["name_similarity"] < candidates.NAME_THRESHOLD
    assert by[(lm, mfc)].left_uei == "ZFN2JJXBLZT3" and by[(lm, mfc)].right_uei is None

    # Deterministic, and the cap keeps the best.
    assert candidates.name_pairs(db, limit=10) == pairs
    assert candidates.name_pairs(db, limit=2) == pairs[:2]
    assert candidates.name_pairs(db, limit=0) == []
    assert candidates.find(db, limit=1).pairs == pairs[:1]


@pytestmark_db
def test_threshold_boundary(db):
    a = org(db, "Northrop Grumman Systems")
    b = org(db, "Northrop Grumman System")
    sim = candidates.name_similarity("Northrop Grumman Systems", "Northrop Grumman System")
    assert candidates.NAME_THRESHOLD < sim < 1.0
    at = candidates.name_pairs(db, limit=5, threshold=sim)
    assert [(p.left_org_id, p.right_org_id) for p in at] == [(a, b)]
    assert candidates.name_pairs(db, limit=5, threshold=sim + 0.001) == []


@pytestmark_db
def test_merged_rows_and_non_companies_are_ignored(db):
    a = org(db, "Kratos Defense")
    b = org(db, "Kratos Defense Inc")
    org(db, "Kratos Defense LLC", kind="office")
    assert len(candidates.name_pairs(db, limit=5)) == 1
    apply.merge(db, a, b, confidence=1.0, source="review")
    assert candidates.name_pairs(db, limit=5) == []
    assert candidates.uei_auto_merges(db) == []


def _decision(decision, confidence, canonical=None):
    return MergeDecision(
        decision=decision,
        canonical_org_id=canonical,
        confidence=confidence,
        evidence=[],
        reasoning="r",
    )


@pytestmark_db
def test_decided_pairs_are_not_proposed_again(db):
    ids = [org(db, f"Vector Aero {suffix}") for suffix in ("Inc", "LLC", "Corp", "Co", "Ltd")]
    pairs = candidates.name_pairs(db, limit=20)
    assert len(pairs) == 10
    by = {(p.left_org_id, p.right_org_id): p for p in pairs}

    def pair(i, j) -> CandidatePair:
        return by[(ids[i], ids[j])]

    # confident separate -> org_non_matches
    apply.apply_decision(db, pair(0, 1), _decision("separate", 0.95), agent_run_id=None)
    # unsure -> open pending row
    apply.apply_decision(db, pair(0, 2), _decision("unsure", 0.5), agent_run_id=None)
    # reviewed and rejected
    apply.apply_decision(db, pair(0, 3), _decision("unsure", 0.5), agent_run_id=None)
    pid = db.execute(
        "SELECT id FROM pending_merges WHERE left_org_id = %s AND right_org_id = %s",
        (ids[0], ids[3]),
    ).fetchone()[0]
    apply.resolve_pending(db, pid, "rejected")

    left = {(p.left_org_id, p.right_org_id) for p in candidates.name_pairs(db, limit=20)}
    assert left == set(by) - {(ids[0], ids[1]), (ids[0], ids[2]), (ids[0], ids[3])}


@pytestmark_db
def test_undone_uei_merge_is_not_redone(db):
    a = org(db, "Acme One", uei="AAAAAAAAAAAA", source="x")
    b = org(db, "Acme 1", uei="AAAAAAAAAAAA", source="y")
    merge_id = apply.merge(db, a, b, confidence=1.0, source="uei")
    apply.undo(db, merge_id)
    assert candidates.uei_auto_merges(db) == []


@pytestmark_db
def test_same_state_and_shared_parent_signals(db):
    def announced(name, location, sid):
        o = org(db, name, source="dod_contracts", source_id=f"company:{name}")
        a = award(
            db,
            sid,
            extraction={"awardees": [{"contractor": name, "location": location}]},
            source="dod_contracts",
        )
        edge(db, "award", a, "awarded_to", "organization", o)
        return o

    a = announced("Aerovironment Inc.", "Simi Valley, California", "1:0")
    b = announced("AeroVironment, Inc", "Arlington, Virginia", "1:1")
    c = announced("Aerovironment Incorporated", "Petaluma, California", "1:2")
    d = org(db, "AEROVIRONMENT, INC.", source="usaspending", source_id="uei:X")  # no location
    parent = org(db, "Holding Group")
    other_parent = org(db, "Other Group")
    edge(db, "organization", a, "part_of", "organization", parent)
    edge(db, "organization", c, "part_of", "organization", parent)
    edge(db, "organization", b, "part_of", "organization", other_parent)

    by = {(p.left_org_id, p.right_org_id): p.signals for p in candidates.name_pairs(db, limit=20)}
    assert by[(a, b)]["same_state"] is False and by[(a, b)]["shared_parent"] is False
    assert by[(a, c)]["same_state"] is True and by[(a, c)]["shared_parent"] is True
    assert by[(a, d)]["same_state"] is None and by[(a, d)]["shared_parent"] is None


# --- UEI hygiene ------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [(" ue9qjd4kk1l6 ", "UE9QJD4KK1L6"), ("", None), ("   ", None), (None, None)],
)
def test_normalize_uei(raw, expected):
    assert candidates.normalize_uei(raw) == expected


@pytest.mark.parametrize(
    "uei,ok",
    [("UE9QJD4KK1L6", True), ("", False), (None, False), ("ABC", False), ("UE9QJD4KK1L6X", False)],
)
def test_is_plausible_uei(uei, ok):
    assert candidates.is_plausible_uei(uei) is ok


@pytestmark_db
def test_blank_or_malformed_ueis_never_auto_merge(db):
    org(db, "Alpha Dynamics", uei=" ")
    org(db, "Bravo Robotics", uei="  ")
    org(db, "Charlie Systems", uei="N/A")
    org(db, "Delta Aerospace", uei="N/A")
    x = org(db, "Echo Autonomy Inc", uei="UNKNOWN")
    y = org(db, "Echo Autonomy, Inc.", uei="unknown ")
    assert candidates.uei_auto_merges(db) == []
    # A shared malformed UEI proves nothing either way: the pair goes to the agent.
    (pair,) = candidates.name_pairs(db, limit=10)
    assert (pair.left_org_id, pair.right_org_id) == (x, y)
    assert pair.signals["different_ueis"] is False


@pytestmark_db
def test_padded_and_lowercase_ueis_are_the_same_uei(db):
    a = org(db, "Leidos Inc.", uei="UE9QJD4KK1L6")
    b = org(db, "LEIDOS, INC.", uei=" ue9qjd4kk1l6 ")
    assert candidates.uei_auto_merges(db) == [candidates.AutoMerge(a, b, "UE9QJD4KK1L6")]
    assert candidates.name_pairs(db, limit=10) == []  # not also sent to the agent


def test_usaspending_normalize_strips_ueis():
    from pipeline.sources.usaspending.normalize import _recipient

    blank = _recipient({"Recipient Name": "ACME", "Recipient UEI": "  ", "recipient_id": "r1"})
    assert blank.uei is None and blank.source_id == "recipient:r1"
    padded = _recipient({"Recipient Name": "ACME", "Recipient UEI": " ue9qjd4kk1l6 "})
    assert padded.uei == "UE9QJD4KK1L6" and padded.source_id == "uei:UE9QJD4KK1L6"


@pytestmark_db
def test_loader_never_stores_a_blank_uei(db):
    from datetime import UTC, datetime

    from pipeline.load.postgres import load_awards
    from pipeline.models import AwardRecord, OrgRef

    ref = OrgRef(source="s", source_id="a", canonical_name="Acme", kind="company", uei="  ")
    when = datetime(2026, 11, 1, tzinfo=UTC)
    load_awards(db, [AwardRecord(source="s", source_id="1", fetched_at=when, recipient=ref)])
    assert db.execute("SELECT uei FROM organizations").fetchall() == [(None,)]


# --- open review questions and the UEI path ---------------------------------------------


@pytestmark_db
def test_open_pending_row_does_not_block_uei_auto_merge(db):
    a = org(db, "Acme One")
    b = org(db, "Acme 1")
    pair = CandidatePair(left_org_id=a, right_org_id=b, left_name="Acme One", right_name="Acme 1")
    assert apply.apply_decision(db, pair, _decision("unsure", 0.5), agent_run_id=None) == "pending"
    # Both rows later gain the same UEI.
    db.execute("UPDATE organizations SET uei = 'AAAAAAAAAAAA' WHERE id IN (%s, %s)", (a, b))
    (auto,) = candidates.uei_auto_merges(db)
    assert (auto.canonical_org_id, auto.other_org_id) == (a, b)
    apply.merge(db, auto.canonical_org_id, auto.other_org_id, confidence=1.0, source="uei")
    assert db.execute("SELECT count(*) FROM pending_merges").fetchone()[0] == 0  # question closed

    # A reviewer's "different" still wins over a shared UEI.
    c = org(db, "Bolt One", uei="BBBBBBBBBBBB")
    d = org(db, "Bolt 1", uei="BBBBBBBBBBBB")
    pair = CandidatePair(left_org_id=c, right_org_id=d, left_name="Bolt One", right_name="Bolt 1")
    apply.apply_decision(db, pair, _decision("unsure", 0.5), agent_run_id=None)
    pending_id = db.execute("SELECT id FROM pending_merges WHERE reviewed_at IS NULL").fetchone()[0]
    apply.resolve_pending(db, pending_id, "rejected")
    assert candidates.uei_auto_merges(db) == []


# --- oversized blocks -------------------------------------------------------------


@pytestmark_db
def test_oversized_block_still_finds_late_duplicates_quickly(db):
    import hashlib
    import time

    n = candidates.MAX_BLOCK_SIZE + 60
    first = org(db, "General Atomics Aeronautical Systems Inc")
    typo_a = org(db, "General Dynamics Land Systems")
    one_token = org(db, "General Inc")
    rows = [
        (f"General {hashlib.md5(str(i).encode()).hexdigest()[:16]} Holdings", f"filler-{i}")
        for i in range(n)
    ]
    with db.cursor() as cur:
        cur.executemany(
            "INSERT INTO organizations (canonical_name, kind, source, source_id)"
            " VALUES (%s, 'company', 't', %s)",
            rows,
        )
    # Duplicates whose ids are far beyond the first MAX_BLOCK_SIZE rows of the block.
    last = org(db, "GENERAL ATOMICS AERONAUTICAL SYSTEMS, INC.")
    typo_b = org(db, "General Dynamcs Land Systems")  # different second token
    one_token_b = org(db, "The General Co")
    division = org(db, "General Atomics Aeronautical Systems Inc., Poway")

    started = time.monotonic()
    pairs = candidates.name_pairs(db, limit=50)
    elapsed = time.monotonic() - started
    found = {(p.left_org_id, p.right_org_id) for p in pairs}
    assert {
        (first, last),
        (typo_a, typo_b),
        (one_token, one_token_b),
        (first, division),
        (last, division),
    } <= found
    assert len(found) < 20  # the random fillers do not pair with each other
    assert elapsed < 5
    assert pairs == candidates.name_pairs(db, limit=50)  # deterministic
