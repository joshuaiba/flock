import json
from datetime import date
from decimal import Decimal

import httpx
import pytest

from pipeline import raw
from pipeline.http import PoliteClient
from pipeline.load.postgres import load_awards
from pipeline.sources.usaspending import fetch, normalize
from tests.conftest import FIXTURES

FIX = FIXTURES / "usaspending"


def recorded_pages():
    p1 = json.loads((FIX / "page1.json").read_text())
    p2 = json.loads((FIX / "page2.json").read_text())
    p2["page_metadata"]["hasNext"] = False  # end pagination after the recorded pages
    return {1: p1, 2: p2}


def fixture_transport(seen):
    pages = recorded_pages()

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append(body)
        return httpx.Response(200, json=pages[body["page"]])

    return httpx.MockTransport(handler)


@pytest.fixture
def lines():
    seen = []
    client = PoliteClient(transport=fixture_transport(seen), sleep=lambda s: None)
    out = list(fetch.fetch(client, ["drone", "unmanned"], today=date(2026, 11, 9)))
    return out, seen


def test_build_request_filters():
    req = fetch.build_request(["drone"], date(2026, 5, 13), date(2026, 11, 9), page=2)
    f = req["filters"]
    assert f["award_type_codes"] == ["A", "B", "C", "D"]
    assert f["agencies"] == [
        {"type": "awarding", "tier": "toptier", "name": "Department of Defense"}
    ]
    assert f["time_period"][0] == {
        "start_date": "2026-05-13",
        "end_date": "2026-11-09",
        "date_type": "date_signed",
    }
    assert req["limit"] == 100 and req["page"] == 2


def test_fetch_paginates_until_hasnext_false(lines):
    out, seen = lines
    assert [b["page"] for b in seen] == [1, 2]
    assert seen[0]["filters"]["time_period"][0]["start_date"] == "2026-05-13"  # 180-day lookback
    assert len(out) == 6
    assert {"fetched_at", "page", "window", "record"} <= out[0].keys()


def test_normalize_first_record(lines):
    out, _ = lines
    award = next(normalize.normalize(out))
    assert award.source == "usaspending"
    assert award.source_id == "CONT_AWD_W15P7T26F0230_9700_W15P7T23D0003_9700"
    assert award.amount == Decimal("224776.0")
    assert award.signed_at == date(2026, 8, 4)
    assert award.description == "PROCURE COMPACT TACTICAL DRONE"
    assert award.url.endswith(award.source_id)
    assert award.recipient.canonical_name == "LEIDOS, INC."
    assert award.recipient.uei == "UE9QJD4KK1L6"
    assert award.recipient.source_id == "uei:UE9QJD4KK1L6"
    assert award.agency.canonical_name == "Department of the Army"
    assert award.agency.parent.canonical_name == "Department of Defense"


def test_normalize_dedupes_repeated_rows(lines):
    out, _ = lines
    assert len(list(normalize.normalize(out + out[:2]))) == 6


def test_snapshot_is_immutable(tmp_path, monkeypatch, lines):
    monkeypatch.setenv("FLOCK_RAW_DIR", str(tmp_path))
    out, _ = lines
    path = raw.write_snapshot("usaspending", date(2026, 11, 9), out)
    assert path == tmp_path / "usaspending" / "2026-11-09.jsonl"
    assert list(raw.read_snapshot(path)) == json.loads(json.dumps(out))
    with pytest.raises(FileExistsError):
        raw.write_snapshot("usaspending", date(2026, 11, 9), out)


@pytest.mark.db
def test_load_is_idempotent(db, lines):
    out, _ = lines
    awards = list(normalize.normalize(out))

    first = load_awards(db, awards)
    assert first.inserted("awards") == 6
    # Leidos appears twice -> 5 distinct recipients + Army, Navy, DoD
    n_orgs = db.execute("SELECT count(*) FROM organizations").fetchone()[0]
    assert first.inserted("organizations") == n_orgs

    second = load_awards(db, awards)
    assert second.inserted("awards") == 0 and second["awards.updated"] == 6
    assert second.inserted("organizations") == 0 and second.inserted("edges") == 0
    assert db.execute("SELECT count(*) FROM awards").fetchone()[0] == 6

    part_of = db.execute(
        """SELECT s.canonical_name, d.canonical_name FROM edges e
           JOIN organizations s ON s.id = e.src_id JOIN organizations d ON d.id = e.dst_id
           WHERE e.rel = 'part_of' ORDER BY 1"""
    ).fetchall()
    assert ("Department of the Army", "Department of Defense") in part_of
