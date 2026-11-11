from datetime import UTC, datetime

import pytest

from pipeline.load.postgres import load_awards
from pipeline.models import AwardRecord, OrgRef
from pipeline.resolve import apply
from pipeline.resolve.models import CandidatePair, Evidence, MergeDecision
from tests.resolve_helpers import award, count, dump, edge, org

pytestmark = pytest.mark.db


def _org_row(db, org_id):
    return db.execute(
        "SELECT canonical_name, uei, aliases, merged_into FROM organizations WHERE id = %s",
        (org_id,),
    ).fetchone()


def _graph(db):
    """A canonical row A and a duplicate B with something in every table that points at B."""
    a = org(db, "Sikorsky Aircraft Corporation", aliases=["Sikorsky"])
    b = org(db, "SIKORSKY AIRCRAFT CORP", uei="UTJWTSLMFNG4", aliases=["Sikorsky Aircraft"])
    parent = org(db, "Lockheed Martin Corporation")
    office = org(db, "Army Contracting Command", kind="office")
    aw1 = award(db, "1", recipient=b, agency=office)
    aw2 = award(db, "2", recipient=a)
    aw3 = award(db, "3", agency=b)  # b as an awarding org, to cover agency_id
    opp = db.execute(
        "INSERT INTO opportunities (title, agency_id, source, source_id)"
        " VALUES ('BAA', %s, 't', 'o1') RETURNING id",
        (b,),
    ).fetchone()[0]
    e_moved = edge(db, "award", aw1, "awarded_to", "organization", b)
    e_dup = edge(db, "award", aw2, "awarded_to", "organization", b)  # A already has this one
    e_keep = edge(db, "award", aw2, "awarded_to", "organization", a)
    e_parent = edge(db, "organization", b, "part_of", "organization", parent)
    e_loop = edge(db, "organization", b, "part_of", "organization", a)  # becomes a self-loop
    e_custom = edge(db, "award", aw3, "mentions", "organization", b, source_id="custom-key")
    tag = db.execute(
        "INSERT INTO tags (slug, source, source_id) VALUES ('uas', 't', 'uas') RETURNING id"
    ).fetchone()[0]
    db.execute(
        "INSERT INTO taggings (entity_type, entity_id, tag_id, confidence, source, source_id)"
        " VALUES ('organization', %s, %s, 0.9, 'c', %s)",
        (b, tag, f"organization:{b}:uas"),
    )
    db.execute(
        "INSERT INTO classifications (entity_type, entity_id, is_autonomy, tags, confidence,"
        " model, text_hash, source, source_id)"
        " VALUES ('organization', %s, true, '{uas}', 0.8, 'm', 'h', 'c', %s)",
        (b, f"organization:{b}"),
    )
    db.commit()
    return {
        "a": a,
        "b": b,
        "parent": parent,
        "aw": (aw1, aw2, aw3),
        "opp": opp,
        "edges": {
            "moved": e_moved,
            "dup": e_dup,
            "keep": e_keep,
            "parent": e_parent,
            "loop": e_loop,
            "custom": e_custom,
        },
    }


def test_merge_repoints_everything_and_undo_restores_exactly(db):
    g = _graph(db)
    a, b = g["a"], g["b"]
    aw1, aw2, aw3 = g["aw"]
    before = dump(db)

    merge_id = apply.merge(db, a, b, confidence=0.97, source="agent")

    # The merged row is kept and points at the canonical one.
    assert _org_row(db, b)[3] == a
    name, uei, aliases, merged_into = _org_row(db, a)
    assert merged_into is None and uei == "UTJWTSLMFNG4"  # filled from the merged row
    assert aliases == ["SIKORSKY AIRCRAFT CORP", "Sikorsky", "Sikorsky Aircraft"]
    assert name not in aliases

    assert db.execute("SELECT recipient_id FROM awards WHERE id = %s", (aw1,)).fetchone()[0] == a
    assert db.execute("SELECT agency_id FROM awards WHERE id = %s", (aw3,)).fetchone()[0] == a
    assert count(db, "opportunities", "agency_id = %s", (a,)) == 1
    assert count(db, "awards", "recipient_id = %s OR agency_id = %s", (b, b)) == 0

    edges = {
        r[0]: r[1:]
        for r in db.execute("SELECT id, src_id, dst_id, source_id FROM edges").fetchall()
    }
    e = g["edges"]
    assert edges[e["moved"]] == (aw1, a, f"award:{aw1}:awarded_to:organization:{a}")
    assert e["dup"] not in edges and e["keep"] in edges  # collision: the moved duplicate goes
    assert e["loop"] not in edges  # A part_of A
    assert edges[e["parent"]] == (
        a,
        g["parent"],
        f"organization:{a}:part_of:organization:{g['parent']}",
    )
    assert edges[e["custom"]] == (aw3, a, "custom-key")  # unknown key format is left alone
    assert count(db, "edges", "src_id = %s AND src_type = 'organization'", (b,)) == 0
    assert count(db, "edges", "dst_id = %s AND dst_type = 'organization'", (b,)) == 0

    assert db.execute("SELECT entity_id, source_id FROM taggings").fetchall() == [
        (a, f"organization:{a}:uas")
    ]
    assert db.execute("SELECT entity_id, source_id FROM classifications").fetchall() == [
        (a, f"organization:{a}")
    ]

    row = db.execute(
        "SELECT canonical_org_id, merged_org_id, decision_source, undone_at, snapshot"
        " FROM org_merges WHERE id = %s",
        (merge_id,),
    ).fetchone()
    assert row[:4] == (a, b, "agent", None)
    assert row[4]["awards_recipient"] == [aw1] and len(row[4]["edges"]) == 5
    assert dump(db) != before

    apply.undo(db, merge_id)
    assert dump(db) == before  # byte for byte: ids, source_ids and timestamps included
    assert db.execute("SELECT undone_at FROM org_merges").fetchone()[0] is not None
    # An undone merge is remembered so the nightly run does not redo it.
    assert count(db, "org_non_matches", "left_org_id = %s AND right_org_id = %s", (a, b)) == 1
    with pytest.raises(apply.MergeError, match="already undone"):
        apply.undo(db, merge_id)


def test_merge_keeps_canonical_uei_and_rejects_same_row(db):
    a = org(db, "Acme", uei="AAAAAAAAAAAA")
    b = org(db, "Acme Inc", uei="BBBBBBBBBBBB")
    apply.merge(db, a, b, confidence=1.0, source="review")
    assert _org_row(db, a)[1] == "AAAAAAAAAAAA"
    with pytest.raises(apply.MergeError, match="already one row"):
        apply.merge(db, a, b, confidence=1.0, source="review")
    with pytest.raises(apply.MergeError, match="no organization"):
        apply.merge(db, a, 10_000, confidence=1.0, source="review")
    assert count(db, "org_merges") == 1


def test_chains_reroot_and_undo_order_is_enforced(db):
    a, b, c, d = (org(db, n) for n in ("Acme", "Acme Inc", "Acme LLC", "Acme Co"))
    aw = award(db, "1", recipient=c)
    start = dump(db)

    m1 = apply.merge(db, b, c, confidence=1.0, source="review")  # c -> b
    after_m1 = dump(db)
    m2 = apply.merge(db, a, b, confidence=1.0, source="review")  # b -> a, c re-rooted to a
    assert _org_row(db, c)[3] == a and _org_row(db, b)[3] == a
    assert db.execute("SELECT recipient_id FROM awards WHERE id = %s", (aw,)).fetchone()[0] == a
    assert _org_row(db, a)[2] == ["Acme Inc", "Acme LLC"]

    # Merging into (or from) an already-merged row resolves to the live row.
    m3 = apply.merge(db, c, d, confidence=1.0, source="review")
    assert _org_row(db, d)[3] == a
    assert db.execute(
        "SELECT canonical_org_id, merged_org_id FROM org_merges WHERE id = %s", (m3,)
    ).fetchone() == (a, d)
    assert apply.live_root(db, c) == a

    # Undo must go newest first while later merges still depend on the rows.
    with pytest.raises(apply.MergeError, match=f"later merge.*{m2}"):
        apply.undo(db, m1)
    with pytest.raises(apply.MergeError, match=f"later merge.*{m3}"):
        apply.undo(db, m2)
    apply.undo(db, m3)
    apply.undo(db, m2)
    assert _org_row(db, c)[3] == b and _org_row(db, b)[3] is None  # chain restored
    assert dump(db) == after_m1
    apply.undo(db, m1)
    assert dump(db) == start


def test_merge_carries_non_matches_and_clears_open_questions(db):
    a, b, x, y = (org(db, n) for n in ("Acme", "Acme Inc", "Acme Robotics", "Acme Marine"))
    apply._record_non_match(db, b, x, 0.95, "different", None)

    def pending(left, right):
        pair = CandidatePair(left_org_id=left, right_org_id=right, left_name="l", right_name="r")
        apply.apply_decision(db, pair, _decision("unsure", 0.4), agent_run_id=None)

    pending(b, y)
    pending(a, y)
    merge_id = apply.merge(db, a, b, confidence=1.0, source="review")
    pairs = db.execute(
        "SELECT left_org_id, right_org_id FROM org_non_matches ORDER BY 1, 2"
    ).fetchall()
    assert pairs == [(a, x), (b, x)]  # what differed from B also differs from A
    open_rows = db.execute("SELECT left_org_id, right_org_id FROM pending_merges").fetchall()
    assert open_rows == [(a, y)]  # the question about B is gone

    apply.undo(db, merge_id)
    assert db.execute(
        "SELECT left_org_id, right_org_id FROM org_non_matches ORDER BY 1, 2"
    ).fetchall() == [(a, b), (b, x)]
    assert count(db, "pending_merges") == 2


def _decision(decision, confidence, canonical=None, evidence=True):
    ev = [Evidence(source="names", url=None, snippet="s", supports="merge")] if evidence else []
    return MergeDecision(
        decision=decision,
        canonical_org_id=canonical,
        confidence=confidence,
        evidence=ev,
        reasoning="because",
    )


def test_apply_decision_routes_by_decision_and_confidence(db):
    ids = [org(db, f"Org {i}") for i in range(10)]

    def pair(i):
        return CandidatePair(
            left_org_id=ids[i], right_org_id=ids[i + 1], left_name="l", right_name="r"
        )

    run_id = None
    cases = [
        (0, _decision("merge", apply.MERGE_CONFIDENCE, ids[1]), "merged"),
        (2, _decision("merge", 0.89, ids[2]), "pending"),
        (4, _decision("separate", apply.SEPARATE_CONFIDENCE), "non_match"),
        (6, _decision("separate", 0.6), "pending"),
        (8, _decision("unsure", 0.99), "pending"),
    ]
    for i, decision, expected in cases:
        assert apply.planned_action(pair(i), decision) == expected
        assert apply.apply_decision(db, pair(i), decision, agent_run_id=run_id) == expected

    assert db.execute(
        "SELECT canonical_org_id, merged_org_id, decision_source FROM org_merges"
    ).fetchall() == [(ids[1], ids[0], "agent")]
    assert db.execute("SELECT left_org_id, right_org_id FROM org_non_matches").fetchall() == [
        (ids[4], ids[5])
    ]
    pending = db.execute(
        "SELECT left_org_id, decision, canonical_org_id, evidence->0->>'supports', reasoning"
        " FROM pending_merges ORDER BY left_org_id"
    ).fetchall()
    assert pending == [
        (ids[2], "merge", ids[2], "merge", "because"),
        (ids[6], "separate", None, "merge", "because"),
        (ids[8], "unsure", None, "merge", "because"),
    ]

    # Asking again about an open pair updates the row instead of adding one.
    apply.apply_decision(db, pair(8), _decision("unsure", 0.2), agent_run_id=None)
    assert count(db, "pending_merges") == 3

    # A canonical id outside the pair is never merged, whatever the confidence.
    stray = _decision("merge", 0.99, 424242)
    assert apply.apply_decision(db, pair(6), stray, agent_run_id=None) == "pending"
    assert count(db, "org_merges") == 1


def test_apply_decision_dry_run_writes_nothing(db):
    a, b = org(db, "Acme"), org(db, "Acme Inc")
    pair = CandidatePair(left_org_id=a, right_org_id=b, left_name="l", right_name="r")
    before = dump(db)
    for decision, expected in [
        (_decision("merge", 0.95, a), "merged"),
        (_decision("separate", 0.95), "non_match"),
        (_decision("unsure", 0.5), "pending"),
    ]:
        assert apply.apply_decision(db, pair, decision, agent_run_id=None, dry_run=True) == expected
    assert dump(db) == before
    assert count(db, "org_merges") + count(db, "pending_merges") + count(db, "org_non_matches") == 0


def test_resolve_pending_accept_reject_and_errors(db):
    a, b, c, d = (org(db, n) for n in ("Acme", "Acme Inc", "Acme LLC", "Acme Co"))

    def queue(left, right, decision):
        pair = CandidatePair(left_org_id=left, right_org_id=right, left_name="l", right_name="r")
        apply.apply_decision(db, pair, decision, agent_run_id=None)
        return db.execute(
            "SELECT id FROM pending_merges WHERE left_org_id = %s AND right_org_id = %s"
            " AND reviewed_at IS NULL",
            (left, right),
        ).fetchone()[0]

    # Accept the agent's proposed canonical row.
    p1 = queue(a, b, _decision("merge", 0.7, b))
    merge_id = apply.resolve_pending(db, p1, "accepted")
    assert db.execute(
        "SELECT canonical_org_id, merged_org_id, decision_source FROM org_merges WHERE id = %s",
        (merge_id,),
    ).fetchone() == (b, a, "review")
    assert db.execute(
        "SELECT reviewer_action, reviewed_at IS NOT NULL FROM pending_merges WHERE id = %s", (p1,)
    ).fetchone() == ("accepted", True)
    with pytest.raises(apply.MergeError, match="already reviewed"):
        apply.resolve_pending(db, p1, "rejected")

    # 'unsure' rows carry no canonical id: the reviewer must choose one of the pair.
    p2 = queue(c, d, _decision("unsure", 0.5))
    with pytest.raises(apply.MergeError, match="pass canonical_org_id"):
        apply.resolve_pending(db, p2, "accepted")
    with pytest.raises(apply.MergeError, match="must be"):
        apply.resolve_pending(db, p2, "accepted", canonical_org_id=a)
    assert count(db, "pending_merges", "reviewed_at IS NULL") == 1  # failures changed nothing
    # Reject: remembered as a non-match.
    assert apply.resolve_pending(db, p2, "rejected") is None
    assert count(db, "org_non_matches", "left_org_id = %s AND right_org_id = %s", (c, d)) == 1
    assert count(db, "org_merges") == 1
    with pytest.raises(apply.MergeError, match="no pending merge"):
        apply.resolve_pending(db, 999, "accepted")

    # Reviewer overrides the canonical row.
    e, f = org(db, "Zeta"), org(db, "Zeta Inc")
    p3 = queue(e, f, _decision("merge", 0.6, e))
    apply.resolve_pending(db, p3, "accepted", canonical_org_id=f)
    assert _org_row(db, e)[3] == f


# --- loaders after a merge -----------------------------------------------------


def _records():
    usa = OrgRef(
        source="usaspending",
        source_id="uei:UE9QJD4KK1L6",
        canonical_name="LEIDOS, INC.",
        kind="company",
        uei="UE9QJD4KK1L6",
    )
    dod = OrgRef(
        source="dod_contracts",
        source_id="company:Leidos Inc.",
        canonical_name="Leidos Inc.",
        kind="company",
    )
    army = OrgRef(source="t", source_id="army", canonical_name="Army", kind="agency")
    when = datetime(2026, 11, 1, tzinfo=UTC)
    return [
        AwardRecord(source="usaspending", source_id="A1", fetched_at=when, recipient=usa),
        AwardRecord(
            source="dod_contracts",
            source_id="100:0",
            fetched_at=when,
            recipient=dod,
            awardees=[dod],
            agency=army,
            url="https://example.gov/100",
        ),
    ]


def _picture(db):
    recipients = db.execute(
        "SELECT a.source_id, o.canonical_name FROM awards a"
        " JOIN organizations o ON o.id = a.recipient_id ORDER BY 1"
    ).fetchall()
    edges = db.execute(
        "SELECT e.source_id, o.canonical_name FROM edges e"
        " JOIN organizations o ON o.id = e.dst_id WHERE e.rel = 'awarded_to' ORDER BY 1"
    ).fetchall()
    return recipients, edges


def test_reload_after_merge_stays_on_canonical_and_undo_restores(db):
    load_awards(db, _records())
    original = _picture(db)
    usa, dod = (
        db.execute("SELECT id FROM organizations WHERE source = %s", (s,)).fetchone()[0]
        for s in ("usaspending", "dod_contracts")
    )
    n_orgs, n_edges, n_awards = (count(db, t) for t in ("organizations", "edges", "awards"))

    merge_id = apply.merge(db, usa, dod, confidence=1.0, source="uei")
    stats = load_awards(db, _records())  # the nightly reload

    # Nothing new, nothing resurrected, nothing pulled back to the merged row.
    assert stats.inserted("organizations") == stats.inserted("edges") == 0
    assert stats.inserted("awards") == 0
    assert (count(db, "organizations"), count(db, "edges"), count(db, "awards")) == (
        n_orgs,
        n_edges,
        n_awards,
    )
    assert _org_row(db, dod)[3] == usa
    recipients, edges = _picture(db)
    assert recipients == [("100:0", "LEIDOS, INC."), ("A1", "LEIDOS, INC.")]
    assert [name for _, name in edges] == ["LEIDOS, INC."]
    assert count(db, "awards", "recipient_id = %s", (dod,)) == 0
    assert count(db, "edges", "dst_type = 'organization' AND dst_id = %s", (dod,)) == 0
    assert _org_row(db, usa)[2] == ["Leidos Inc."]

    # A new spelling arriving under the merged row's key lands on the canonical row too.
    renamed = _records()[1]
    renamed.recipient.aliases = ["Leidos Incorporated"]
    load_awards(db, [renamed])
    assert _org_row(db, usa)[2] == ["Leidos Inc.", "Leidos Incorporated"]

    apply.undo(db, merge_id)
    load_awards(db, _records())
    assert _picture(db) == original
    assert _org_row(db, dod)[3] is None
    assert (count(db, "organizations"), count(db, "edges"), count(db, "awards")) == (
        n_orgs,
        n_edges,
        n_awards,
    )


def test_loader_skips_self_parent_edge_after_merge(db):
    parent = OrgRef(source="t", source_id="p", canonical_name="Parent Co", kind="company")
    child = OrgRef(
        source="t",
        source_id="c",
        canonical_name="Parent Co Division",
        kind="company",
        parent=parent,
    )
    rec = AwardRecord(
        source="t", source_id="1", fetched_at=datetime(2026, 11, 1, tzinfo=UTC), recipient=child
    )
    load_awards(db, [rec])
    p, c = (
        db.execute("SELECT id FROM organizations WHERE source_id = %s", (s,)).fetchone()[0]
        for s in ("p", "c")
    )
    apply.merge(db, p, c, confidence=1.0, source="review")
    assert count(db, "edges", "rel = 'part_of'") == 0
    load_awards(db, [rec])
    assert count(db, "edges", "rel = 'part_of'") == 0  # no Parent part_of Parent
