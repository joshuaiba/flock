from collections import Counter
from datetime import date, datetime

import httpx
import pytest

from pipeline.extract.contract_announcement import ContractAnnouncement
from pipeline.http import PoliteClient
from pipeline.load.postgres import load_awards
from pipeline.sources.dod_contracts import fetch, normalize, run
from tests.conftest import FIXTURES
from tests.fakes import FakeProvider

FIX = FIXTURES / "dod_contracts"
JAN27 = (FIX / "article_4042540.html").read_text()


def test_parse_rss():
    articles = fetch.parse_rss((FIX / "rss.xml").read_text())
    assert len(articles) == 10
    a = articles[0]
    assert a.article_id == "4645461"
    assert a.url.startswith("https://www.war.gov/News/Contracts/Contract/Article/4645461/")
    assert a.announced_on == date(2026, 11, 9)


@pytest.mark.parametrize(
    "title,expected",
    [
        ("Contracts For Jan. 27, 2025", date(2025, 1, 27)),
        ("Contracts for Sept. 3, 2026", date(2026, 9, 3)),
        ("Contracts for June 6, 2025", date(2025, 6, 6)),
        ("Something else", None),
    ],
)
def test_title_date(title, expected):
    assert fetch.title_date(title) == expected


def test_split_paragraphs_handles_sections_and_unclosed_p():
    paras = normalize.split_paragraphs(JAN27)
    assert len(paras) == 12  # 6 Air Force + 5 Navy + 1 DFAS; headers + footnote dropped
    assert [p.index for p in paras] == list(range(12))
    assert paras[0].section == "AIR FORCE"
    assert paras[0].text.startswith("General Electric Co., GE Edison Works, Cincinnati, Ohio")
    # unclosed <p>: first paragraph must not swallow the second
    assert "Raytheon" not in paras[0].text
    assert paras[6].section == "NAVY"
    assert paras[-1].section == "DEFENSE FINANCE AND ACCOUNTING SERVICE"
    assert "&amp;" not in paras[9].text and "Bayonne Dry Dock & Repair" in paras[10].text
    assert not any(p.text.startswith("*") for p in paras)


def test_second_fixture_splits():
    paras = normalize.split_paragraphs((FIX / "article_4208884.html").read_text())
    assert len(paras) == 13
    assert {p.section for p in paras} == {
        "ARMY",
        "NAVY",
        "DEFENSE ADVANCED RESEARCH PROJECTS AGENCY",
        "AIR FORCE",
    }


def test_page_meta():
    meta = normalize.page_meta(JAN27)
    assert fetch.article_id(meta["url"]) == "4042540"
    assert fetch.title_date(meta["title"]) == date(2025, 1, 27)


def _client(handler, seen):
    def h(req):
        seen.append(req)
        return handler(req)

    return PoliteClient(transport=httpx.MockTransport(h), sleep=lambda s: None, max_retries=0)


ARTICLE = fetch.Article(
    "4042540",
    "https://www.war.gov/News/Contracts/Contract/Article/4042540/x/",
    "Contracts For Jan. 27, 2025",
)


def test_blocked_without_unlocker_fails_loudly():
    seen = []
    client = _client(lambda r: httpx.Response(403, text="Access Denied"), seen)
    with pytest.raises(fetch.BlockedError, match="BRIGHTDATA_API_KEY"):
        fetch.fetch_article_html(client, ARTICLE, None)
    assert len(seen) == 1 and seen[0].headers["User-Agent"].startswith("flock/")


def test_unlocker_used_only_after_direct_403(monkeypatch):
    seen = []

    def handler(req):
        if req.url.host == "api.brightdata.com":
            return httpx.Response(200, text=JAN27)
        return httpx.Response(403)

    client = _client(handler, seen)
    monkeypatch.delenv("BRIGHTDATA_API_KEY", raising=False)
    assert fetch.BrightDataUnlocker.from_env(client) is None
    monkeypatch.setenv("BRIGHTDATA_API_KEY", "k")
    monkeypatch.setenv("BRIGHTDATA_ZONE", "z")
    html, via = fetch.fetch_article_html(client, ARTICLE, fetch.BrightDataUnlocker.from_env(client))
    assert via == "brightdata" and html == JAN27
    assert [r.url.host for r in seen] == ["www.war.gov", "api.brightdata.com"]
    bd = seen[1]
    assert bd.headers["Authorization"] == "Bearer k"
    assert (
        httpx.Request("POST", "x", json={"zone": "z", "url": ARTICLE.url, "format": "raw"}).content
        == bd.content
    )


def test_direct_success_skips_unlocker():
    seen = []
    client = _client(lambda r: httpx.Response(200, text=JAN27), seen)
    unlocker = fetch.BrightDataUnlocker(client, "k", "z")
    assert fetch.fetch_article_html(client, ARTICLE, unlocker) == (JAN27, "direct")
    assert len(seen) == 1


def test_unlocker_error_is_blocked():
    client = _client(lambda r: httpx.Response(401, text="bad key"), [])
    with pytest.raises(fetch.BlockedError, match="401"):
        fetch.BrightDataUnlocker(client, "k", "z").fetch(ARTICLE.url)


def fake_extraction(prompt, schema):
    if "Aktarius LLC" in prompt:  # multiple-award paragraph
        return {
            "awardees": [
                {
                    "contractor": "Aktarius LLC",
                    "location": "Panama City, Florida",
                    "contract_number": "FA4877-25-D-0008",
                    "small_business": False,
                },
                {
                    "contractor": "DAP Construction Management LLC",
                    "location": "Phoenix, Arizona",
                    "contract_number": "FA4877-25-D-0009",
                    "small_business": False,
                },
            ],
            "amount_usd": 350000000,
            "amount_type": "ceiling",
            "contract_number": None,
            "awarding_office": "Air Force Civil Engineer Center, Tyndall AFB, Florida",
            "description": "Construction program.",
            "completion_date": "2032-01-27",
            "is_modification": False,
        }
    name = prompt.split("<text>\n", 1)[1].split(",", 1)[0]
    return {
        "awardees": [
            {"contractor": name, "location": None, "contract_number": None, "small_business": False}
        ],
        "amount_usd": 1e7,
        "amount_type": "obligation",
        "contract_number": "X-1",
        "awarding_office": None,
        "description": "Stuff.",
        "completion_date": None,
        "is_modification": False,
    }


def _lines():
    return [run._line(ARTICLE, JAN27, "inbox")]


def test_to_award_multi_awardee():
    para = normalize.split_paragraphs(JAN27)[2]
    ext = ContractAnnouncement.model_validate(fake_extraction("<text>\nAktarius LLC, x", {}))
    award = normalize.to_award(
        article_id="4042540",
        url=ARTICLE.url,
        announced_on=date(2025, 1, 27),
        fetched_at=datetime(2025, 1, 28),
        paragraph=para,
        extraction=ext,
        model="fake:test",
    )
    assert award.source_id == "4042540:2"
    assert award.recipient is None and len(award.awardees) == 2
    assert award.agency.kind == "office" and award.agency.parent.canonical_name == "Air Force"
    assert award.raw_text == para.text and award.extraction["amount_type"] == "ceiling"


@pytest.mark.db
def test_extract_and_load_stores_raw_text_and_caches(db, monkeypatch):
    provider = FakeProvider(fake_extraction)
    monkeypatch.setattr(run.llm, "get_provider", lambda: provider)

    counts = Counter()
    awards = run.extract_awards(_lines(), {}, counts)
    assert counts["extractions.new"] == 12 and len(provider.calls) == 12
    stats = load_awards(db, awards)
    assert stats.inserted("awards") == 12

    row = db.execute(
        "SELECT raw_text, extraction->>'amount_type', extraction_model, recipient_id, signed_at"
        " FROM awards WHERE source_id = '4042540:2'"
    ).fetchone()
    assert row[0].startswith("Aktarius LLC") and row[1] == "ceiling"
    assert row[2] == "fake:test" and row[3] is None and row[4] == date(2025, 1, 27)
    awarded_to = db.execute(
        "SELECT o.canonical_name FROM edges e JOIN awards a ON a.id = e.src_id"
        " JOIN organizations o ON o.id = e.dst_id"
        " WHERE e.rel = 'awarded_to' AND a.source_id = '4042540:2' ORDER BY 1"
    ).fetchall()
    assert awarded_to == [("Aktarius LLC",), ("DAP Construction Management LLC",)]
    assert run.loaded_article_ids(db) == {"4042540"}

    # Second pass: unchanged paragraphs reuse the stored extraction, no LLM calls.
    existing = {
        r[0]: r[1:]
        for r in db.execute("SELECT source_id, raw_text, extraction, extraction_model FROM awards")
    }
    counts2 = Counter()
    awards2 = run.extract_awards(_lines(), existing, counts2)
    assert counts2["extractions.cached"] == 12 and len(provider.calls) == 12
    assert load_awards(db, awards2).inserted("awards") == 0


def test_inbox_picks_up_saved_pages(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "INBOX", tmp_path)
    (tmp_path / "saved.html").write_text(JAN27)
    (tmp_path / "junk.html").write_text("<html>nothing</html>")
    lines = run.inbox_lines(set())
    assert [ln["article_id"] for ln in lines] == ["4042540"]
    assert lines[0]["announced_on"] == "2025-01-27" and lines[0]["via"] == "inbox"
    assert run.inbox_lines({"4042540"}) == []
