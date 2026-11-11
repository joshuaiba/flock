import json
import logging

import httpx
import psycopg
import pytest
from pydantic import ValidationError
from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

from pipeline.agents import settings as agent_settings
from pipeline.http import PoliteClient
from pipeline.resolve import addresses, http_cache, tools
from pipeline.resolve.deps import ResolveDeps
from pipeline.resolve.models import CandidatePair, Evidence, MergeDecision
from tests.conftest import FIXTURES

FIX = FIXTURES / "resolve"
SAM_KEY = "sekret-sam-key-123"
SIKORSKY_ID = "d64537c9-5482-dd40-cdd4-5cf07b66329d-C"
JV_ID = "3b77cd29-f995-1212-a302-18cb53bad99a-C"


def load(name):
    return json.loads((FIX / name).read_text())


def upstream(seen, *, sam_status=200, sam_body=None):
    """Recorded USAspending responses + the doc-derived SAM response."""

    def handler(req: httpx.Request):
        seen.append(req)
        if req.url.host == "api.sam.gov":
            body = load("sam_entity_sikorsky.json") if sam_body is None else sam_body
            return httpx.Response(sam_status, json=body)
        if req.url.path == "/api/v2/recipient/":
            return httpx.Response(200, json=load("usaspending_search_sikorsky.json"))
        rid = req.url.path.rstrip("/").rsplit("/", 1)[-1]
        path = FIX / f"usaspending_recipient_{rid}.json"
        if path.exists():
            return httpx.Response(200, json=json.loads(path.read_text()))
        return httpx.Response(404, json={"detail": "Recipient not found"})

    return httpx.MockTransport(handler)


def make_ctx(db, seen=None, *, key=SAM_KEY, quota=10, transport=None, max_retries=0):
    seen = [] if seen is None else seen
    client = PoliteClient(
        transport=transport or upstream(seen),
        sleep=lambda s: None,
        min_interval=0,
        max_retries=max_retries,
    )
    deps = ResolveDeps(conn=db, http=client, sam_api_key=key, sam_daily_quota=quota)
    return RunContext(deps=deps, model=TestModel(), usage=RunUsage())


def cache_dump(db) -> str:
    rows = db.execute("SELECT cache_key, host, url, params, status, body FROM http_cache")
    return json.dumps(rows.fetchall(), default=str)


# --- models / deps -----------------------------------------------------------


def test_merge_decision_constraints():
    ev = Evidence(source="sam", url=None, snippet="same UEI", supports="merge")
    ok = MergeDecision(
        decision="merge", canonical_org_id=1, confidence=0.95, evidence=[ev], reasoning="r"
    )
    assert ok.canonical_org_id == 1
    base = {"confidence": 0.5, "evidence": [], "reasoning": "r"}
    with pytest.raises(ValidationError, match="canonical_org_id"):
        MergeDecision(decision="merge", canonical_org_id=None, **base)
    with pytest.raises(ValidationError):
        MergeDecision(decision="maybe", canonical_org_id=None, **base)
    with pytest.raises(ValidationError):
        MergeDecision(decision="unsure", canonical_org_id=None, **{**base, "confidence": 1.2})
    with pytest.raises(ValidationError):
        Evidence(source="wikipedia", url=None, snippet="x", supports="merge")
    schema = MergeDecision.model_json_schema()
    assert schema["properties"]["decision"]["enum"] == ["merge", "separate", "unsure"]
    assert schema["$defs"]["Evidence"]["properties"]["source"]["enum"] == [
        "sam",
        "usaspending",
        "db",
        "address",
        "names",
    ]


def test_deps_from_settings_hides_key(monkeypatch):
    monkeypatch.setenv("SAM_API_KEY", SAM_KEY)
    monkeypatch.setenv("SAM_DAILY_QUOTA", "1000")
    agent_settings.reset_settings()
    pair = CandidatePair(left_org_id=1, right_org_id=2, left_name="A", right_name="B")
    deps = ResolveDeps.from_settings(conn=None, http=None, pair=pair)
    assert deps.sam_api_key == SAM_KEY and deps.sam_daily_quota == 1000 and deps.pair is pair
    assert SAM_KEY not in repr(deps)


# --- SAM.gov -----------------------------------------------------------------


@pytest.mark.db
def test_sam_lookup_by_uei_parses_and_caches(db, caplog):
    seen = []
    ctx = make_ctx(db, seen)
    with caplog.at_level(logging.DEBUG):
        out = tools.lookup_sam_entity(ctx, uei="utjwtslmfng4")
    assert out.status == "ok" and out.total_matches == 1
    e = out.entities[0]
    assert e.uei == "UTJWTSLMFNG4" and e.legal_name == "SIKORSKY AIRCRAFT CORPORATION"
    assert e.dba_name == "SIKORSKY, A LOCKHEED MARTIN COMPANY" and e.cage_code == "78286"
    assert e.address == "6900 MAIN ST, STRATFORD, CT 06614" and e.state == "CT"
    assert e.immediate_parent_uei == "ZFN2JJXBLZT3"
    assert e.ultimate_parent_name == "LOCKHEED MARTIN CORPORATION"
    assert (
        out.source_url == "https://api.sam.gov/entity-information/v4/entities?ueiSAM=UTJWTSLMFNG4"
    )

    req = seen[0]
    assert req.url.path == "/entity-information/v4/entities"
    assert dict(req.url.params) == {
        "ueiSAM": "UTJWTSLMFNG4",
        "includeSections": "entityRegistration,coreData",
        "api_key": SAM_KEY,
    }
    assert req.headers["User-Agent"].startswith("flock/")

    # Second identical lookup is served from the cache: no HTTP, no quota.
    again = tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4")
    assert again == out and len(seen) == 1
    assert http_cache.requests_today(db, "api.sam.gov") == 1

    # The key is never stored or logged (httpx logs full request URLs at INFO).
    assert SAM_KEY not in cache_dump(db) and "api_key" not in cache_dump(db)
    assert "api.sam.gov" in caplog.text and SAM_KEY not in caplog.text
    assert SAM_KEY not in out.model_dump_json()


@pytest.mark.db
def test_sam_lookup_by_name_and_not_found(db):
    seen = []
    ctx = make_ctx(db, seen)
    assert tools.lookup_sam_entity(ctx, name="  Sikorsky   Aircraft ").status == "ok"
    assert seen[0].url.params["legalBusinessName"] == "SIKORSKY AIRCRAFT"
    assert "ueiSAM" not in seen[0].url.params
    # Case and spacing variants are one cache entry and one request against the quota.
    for variant in ("SIKORSKY AIRCRAFT", "sikorsky aircraft", "Sikorsky  Aircraft"):
        assert tools.lookup_sam_entity(ctx, name=variant).status == "ok"
    assert len(seen) == 1 and http_cache.requests_today(db, "api.sam.gov") == 1

    empty = upstream([], sam_body={"totalRecords": 0, "entityData": []})
    out = tools.lookup_sam_entity(make_ctx(db, transport=empty), name="No Such Company")
    assert out.status == "not_found" and out.entities == []


@pytest.mark.db
def test_sam_quota_exhaustion_counts_only_real_requests(db):
    seen = []
    ctx = make_ctx(db, seen, quota=2)
    assert tools.lookup_sam_entity(ctx, uei="AAAAAAAAAAA1").status == "ok"
    assert tools.lookup_sam_entity(ctx, uei="AAAAAAAAAAA1").status == "ok"  # cache hit
    assert tools.lookup_sam_entity(ctx, uei="AAAAAAAAAAA2").status == "ok"
    out = tools.lookup_sam_entity(ctx, uei="AAAAAAAAAAA3")
    assert out.status == "unavailable" and "quota" in out.detail
    assert len(seen) == 2
    # Already-cached lookups still work once the quota is gone.
    assert tools.lookup_sam_entity(ctx, uei="AAAAAAAAAAA2").status == "ok"
    # A refused lookup sent nothing and logged nothing.
    assert http_cache.requests_today(db, "api.sam.gov") == 2
    # Yesterday's requests don't count against today.
    db.execute("UPDATE http_requests SET requested_at = now() - interval '2 days'")
    assert http_cache.requests_today(db, "api.sam.gov") == 0


@pytest.mark.db
def test_sam_quota_counts_every_request_not_cache_rows(db):
    """Re-fetching one key (expired error entry) upserts its cache row in place;
    each of those is still a request against the daily quota."""
    seen = []
    limited = upstream(seen, sam_status=429, sam_body={"error": "rate limited"})
    ctx = make_ctx(db, seen, quota=3, transport=limited)
    for _ in range(6):
        out = tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4")
        assert out.status == "unavailable"
        db.execute(
            "UPDATE http_cache SET fetched_at = now() - interval '2 hours'"
        )  # past ERROR_TTL
    assert len(seen) == 3  # the 4th, 5th and 6th were refused before sending
    assert "quota" in out.detail
    assert http_cache.requests_today(db, "api.sam.gov") == 3
    assert db.execute("SELECT count(*) FROM http_cache").fetchone()[0] == 1
    assert db.execute("SELECT DISTINCT status FROM http_requests").fetchall() == [(429,)]


@pytest.mark.db
def test_quota_counts_attempts_that_end_in_transport_errors(db):
    def boom(req):
        raise httpx.ConnectError("connection refused")

    ctx = make_ctx(db, quota=2, transport=httpx.MockTransport(boom))
    for _ in range(3):
        assert tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4").status == "unavailable"
    # Logged before sending, so the failed attempts count; the third was refused.
    assert db.execute(
        "SELECT count(*), count(status) FROM http_requests WHERE host = 'api.sam.gov'"
    ).fetchone() == (2, 0)
    assert db.execute("SELECT count(*) FROM http_cache").fetchone()[0] == 0


@pytest.mark.db
def test_request_log_survives_rollback_on_an_autocommit_cache_connection(db):
    """With deps.cache_conn (what agent.decide sets up) the quota count is durable
    even if the caller's transaction is rolled back, and the caller's transaction
    is not committed by the tool."""
    db.commit()
    dsn = psycopg.conninfo.make_conninfo(db.info.dsn, password=db.info.password)
    seen = []
    ctx = make_ctx(db, seen)
    with psycopg.connect(dsn, autocommit=True) as side:
        ctx.deps.cache_conn = side
        db.execute(
            "INSERT INTO organizations (canonical_name, kind, source, source_id)"
            " VALUES ('pending work', 'company', 't', 'p')"
        )
        assert tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4").status == "ok"
        db.rollback()
    assert db.execute("SELECT count(*) FROM organizations").fetchone()[0] == 0  # not committed
    assert http_cache.requests_today(db, "api.sam.gov") == 1
    assert db.execute("SELECT count(*) FROM http_cache").fetchone()[0] == 1


@pytest.mark.db
def test_cache_and_request_rows_carry_wall_clock_time_not_transaction_start(db):
    db.commit()
    tx_start = db.execute("SELECT now()").fetchone()[0]  # opens the transaction
    db.execute("SELECT pg_sleep(0.05)")
    tools.lookup_sam_entity(make_ctx(db), uei="UTJWTSLMFNG4")
    fetched, requested = db.execute(
        "SELECT (SELECT fetched_at FROM http_cache), (SELECT requested_at FROM http_requests)"
    ).fetchone()
    assert fetched > tx_start and requested > tx_start


@pytest.mark.db
def test_http_requests_table_exists_with_index(db):
    cols = {
        r[0]
        for r in db.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'http_requests'"
        )
    }
    assert cols == {"id", "host", "cache_key", "status", "requested_at"}
    assert db.execute(
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'http_requests_host_requested_idx'"
    ).fetchone() == (1,)


@pytest.mark.db
def test_sam_missing_key_makes_no_request(db):
    seen = []
    out = tools.lookup_sam_entity(make_ctx(db, seen, key=None), uei="UTJWTSLMFNG4")
    assert out.status == "unavailable" and "not configured" in out.detail
    assert seen == [] and db.execute("SELECT count(*) FROM http_cache").fetchone()[0] == 0


@pytest.mark.db
def test_sam_errors_are_unavailable_and_briefly_cached(db):
    seen = []
    denied = upstream(seen, sam_status=403, sam_body={"error": {"code": "API_KEY_INVALID"}})
    ctx = make_ctx(db, seen, transport=denied)
    out = tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4")
    assert out.status == "unavailable" and "403" in out.detail
    # Served from the short error cache: the failing upstream is not hammered,
    # and the request counted against the quota.
    assert tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4").status == "unavailable"
    assert len(seen) == 1 and http_cache.requests_today(db, "api.sam.gov") == 1
    # After ERROR_TTL it is retried, and the retry is a second request against the quota.
    db.execute("UPDATE http_cache SET fetched_at = now() - interval '2 hours'")
    tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4")
    assert len(seen) == 2 and http_cache.requests_today(db, "api.sam.gov") == 2


@pytest.mark.db
def test_sam_rejected_query_is_bad_query_not_unavailable(db):
    """A 400 is about this query, not the service: the model may keep using SAM."""
    seen = []
    rejected = upstream(seen, sam_status=400, sam_body={"error": "invalid search parameter"})
    ctx = make_ctx(db, seen, transport=rejected)
    out = tools.lookup_sam_entity(ctx, name="ACME (HOLDINGS) & CO")
    assert out.status == "bad_query" and "400" in out.detail and out.entities == []
    for status in (401, 403, 429, 500, 503):
        down = upstream([], sam_status=status, sam_body={"error": "x"})
        out = tools.lookup_sam_entity(make_ctx(db, transport=down), uei=f"AAAAAAAAA{status}")
        assert out.status == "unavailable", status


@pytest.mark.db
def test_html_200_is_not_cached_as_a_definitive_answer(db):
    """A maintenance page served with status 200 must not block lookups for 30 days."""
    seen = []
    state = {"html": True}

    def handler(req):
        seen.append(req)
        if state["html"]:
            return httpx.Response(200, text="<html>Scheduled maintenance</html>")
        if req.url.host == "api.sam.gov":
            return httpx.Response(200, json=load("sam_entity_sikorsky.json"))
        return httpx.Response(200, json=load("usaspending_search_sikorsky.json"))

    ctx = make_ctx(db, seen, transport=httpx.MockTransport(handler))
    assert tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4").status == "unavailable"
    assert tools.search_usaspending_recipient(ctx, "Sikorsky Aircraft").status == "unavailable"
    assert db.execute("SELECT status, body FROM http_cache").fetchall() == [(200, None)] * 2
    # A JSON 200 that is not an object (e.g. a bare list) is treated the same way.
    assert not http_cache.is_definitive(200, ["x"]) and http_cache.is_definitive(200, {})
    assert http_cache.is_definitive(404, None) and not http_cache.is_definitive(403, {})

    state["html"] = False
    # Within ERROR_TTL the short-lived entry is still served ...
    assert tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4").status == "unavailable"
    n = len(seen)
    # ... but a day later (well inside the 30-day TTL) the upstream is asked again.
    db.execute("UPDATE http_cache SET fetched_at = now() - interval '1 day'")
    assert tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4").status == "ok"
    assert tools.search_usaspending_recipient(ctx, "Sikorsky Aircraft").status == "ok"
    assert len(seen) > n


@pytest.mark.db
def test_sam_transport_error_is_unavailable_without_leaking_key(db, caplog):
    def boom(req):
        raise httpx.ConnectError(f"cannot connect to {req.url}")

    # max_retries=1 is what the runner uses: PoliteClient's retry warning must be
    # redacted too, not only the tool's own log line.
    ctx = make_ctx(db, transport=httpx.MockTransport(boom), max_retries=1)
    with caplog.at_level(logging.DEBUG):
        out = tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4")
    assert out.status == "unavailable" and SAM_KEY not in caplog.text
    assert any(r.name == "pipeline.http" and "retrying" in r.getMessage() for r in caplog.records)
    assert "api_key=REDACTED" in caplog.text
    assert SAM_KEY not in out.model_dump_json()


@pytest.mark.db
@pytest.mark.parametrize(
    "error",
    [
        httpx.TooManyRedirects("too many redirects"),
        httpx.DecodingError("bad gzip"),
        httpx.ReadTimeout("timed out"),
    ],
)
def test_http_errors_of_any_kind_are_unavailable_not_exceptions(db, error):
    def boom(req):
        raise error

    ctx = make_ctx(db, transport=httpx.MockTransport(boom))
    assert tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4").status == "unavailable"
    assert tools.search_usaspending_recipient(ctx, "Sikorsky Aircraft").status == "unavailable"


@pytest.mark.db
def test_malformed_upstream_shapes_do_not_raise(db):
    def sam(body):
        return tools.lookup_sam_entity(
            make_ctx(db, transport=upstream([], sam_body=body)), uei=sam.next_uei()
        )

    counter = iter(range(100))
    sam.next_uei = lambda: f"BBBBBBBBBB{next(counter):02d}"
    assert sam({"entityData": "oops"}).status == "unavailable"
    assert sam({"entityData": ["not a dict"]}).status == "not_found"
    assert sam({"entityData": [{"entityRegistration": {"ueiSAM": {"nested": 1}}}]}).status == (
        "unavailable"
    )
    out = sam({"entityData": [{"entityRegistration": None, "coreData": "x"}]})
    assert out.status == "ok" and out.entities[0].legal_name is None

    def usa(results):
        def handler(req):
            if req.url.path == "/api/v2/recipient/":
                return httpx.Response(200, json={"results": results})
            return httpx.Response(200, json={"location": "nowhere", "parents": [1, None]})

        ctx = make_ctx(db, transport=httpx.MockTransport(handler))
        return tools.search_usaspending_recipient(ctx, f"Query {next(counter)}")

    assert usa({"not": "a list"}).status == "unavailable"
    # Rows without an id are skipped (this used to be a KeyError that ended the run).
    out = usa([{"name": "NO ID CO"}, "junk", {"id": "abc-C", "name": "HAS ID CO", "amount": "x"}])
    assert out.status == "ok" and [r.name for r in out.recipients] == ["HAS ID CO"]
    assert out.recipients[0].amount_12mo is None and out.recipients[0].address is None
    assert usa([{"name": "NO ID CO"}]).status == "not_found"


def test_records_without_a_street_line_have_no_comparable_address():
    """Two registrations in the same town must not look like the same address."""
    line, state = tools._sam_address(
        {"addressLine1": None, "city": "STRATFORD", "stateOrProvinceCode": "CT", "zipCode": "06614"}
    )
    assert line is None and state == "CT"
    rec = tools.UsaspendingRecipient(
        recipient_id="x", name="X", uei=None, level=None, amount_12mo=None, url="u"
    )
    tools._usaspending_detail(
        rec,
        {"location": {"address_line1": " ", "city_name": "STRATFORD", "state_code": "CT"}},
    )
    assert rec.address is None and rec.state == "CT"
    full, _ = tools._sam_address(
        {
            "addressLine1": "6900 MAIN ST",
            "city": "STRATFORD",
            "stateOrProvinceCode": "CT",
            "zipCode": "06614",
        }
    )
    assert full == "6900 MAIN ST, STRATFORD, CT 06614"


@pytest.mark.db
def test_sam_argument_validation(db):
    ctx = make_ctx(db)
    for kwargs in (
        {},
        {"uei": "UTJWTSLMFNG4", "name": "Sikorsky"},
        {"uei": "short"},
        {"name": "x"},
    ):
        with pytest.raises(ModelRetry):
            tools.lookup_sam_entity(ctx, **kwargs)


@pytest.mark.db
def test_cache_expires_after_ttl(db):
    seen = []
    ctx = make_ctx(db, seen)
    tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4")
    db.execute("UPDATE http_cache SET fetched_at = now() - interval '31 days'")
    tools.lookup_sam_entity(ctx, uei="UTJWTSLMFNG4")
    assert len(seen) == 2
    assert db.execute("SELECT count(*) FROM http_cache").fetchone()[0] == 1  # refreshed in place


def test_cache_key_is_stable_and_distinguishes_requests():
    k = http_cache.cache_key
    assert k("get", "https://x/y", {"a": "1", "b": "2"}) == k(
        "GET", "https://x/y", {"b": "2", "a": "1"}
    )
    assert k("GET", "https://x/y", {"a": "1"}) != k("GET", "https://x/y", {"a": "2"})
    assert k("POST", "https://x/y", None, {"q": "a"}) != k("POST", "https://x/y", None, {"q": "b"})


# --- USAspending -------------------------------------------------------------


@pytest.mark.db
def test_usaspending_search_parses_parents_and_caps_requests(db):
    seen = []
    ctx = make_ctx(db, seen)
    out = tools.search_usaspending_recipient(ctx, "SIKORSKY AIRCRAFT")
    assert out.status == "ok" and out.total_matches == 13 and len(out.recipients) == 5

    # 1 search + details for the top 3 only.
    assert [r.method for r in seen] == ["POST", "GET", "GET", "GET"]
    assert json.loads(seen[0].content) == {
        "keyword": "SIKORSKY AIRCRAFT",
        "limit": 5,
        "award_type": "all",
    }

    sik, jv, third, fourth = out.recipients[:4]
    assert sik.recipient_id == SIKORSKY_ID and sik.uei == "UTJWTSLMFNG4" and sik.level == "C"
    assert sik.parent_name == "RTX CORPORATION" and sik.parent_uei == "PPLZG8J3N9D4"
    assert sik.other_parents == [
        "LOCKHEED MARTIN CORPORATION (JSQTW5L2SSM1)",
        "LOCKHEED MARTIN CORP (ZFN2JJXBLZT3)",
    ]
    assert sik.alternate_names == ["SIKORSKY AIRCRAFT CORP"]
    assert sik.address == "6900 MAIN ST, STRATFORD, CT 06614" and sik.state == "CT"
    assert sik.url == f"https://www.usaspending.gov/recipient/{SIKORSKY_ID}/latest"

    assert jv.recipient_id == JV_ID and jv.name == "BOEING SIKORSKY AIRCRAFT SUPPORT, LLC"
    assert jv.parent_name == "THE BOEING COMPANY" and jv.state == "KY"
    # The third detail page was not recorded (404): basic fields only, no failure.
    assert third.level == "P" and third.parent_name is None and third.address is None
    assert fourth.address is None  # beyond the detail cap

    # Fully cached on repeat, including the definitive 404.
    assert tools.search_usaspending_recipient(ctx, "SIKORSKY AIRCRAFT") == out
    assert len(seen) == 4
    assert db.execute("SELECT count(*), count(body) FROM http_cache").fetchone() == (4, 4)
    stored = db.execute(
        "SELECT params FROM http_cache WHERE url = %s", (tools.USASPENDING_SEARCH_URL,)
    ).fetchone()[0]
    assert stored["json"]["keyword"] == "SIKORSKY AIRCRAFT"


@pytest.mark.db
def test_usaspending_no_results_and_errors(db):
    def empty(req):
        return httpx.Response(200, json={"page_metadata": {"total": 0}, "results": []})

    out = tools.search_usaspending_recipient(
        make_ctx(db, transport=httpx.MockTransport(empty)), "Nonexistent Co"
    )
    assert out.status == "not_found"

    down = httpx.MockTransport(lambda req: httpx.Response(503, text="down"))
    out = tools.search_usaspending_recipient(make_ctx(db, transport=down), "Other Co")
    assert out.status == "unavailable" and "503" in out.detail

    with pytest.raises(ModelRetry):
        tools.search_usaspending_recipient(make_ctx(db), " ")


# --- our database ------------------------------------------------------------


def _org(db, name, sid, merged_into=None, uei=None):
    return db.execute(
        "INSERT INTO organizations (canonical_name, kind, source, source_id, merged_into, uei)"
        " VALUES (%s, 'company', 't', %s, %s, %s) RETURNING id",
        (name, sid, merged_into, uei),
    ).fetchone()[0]


def _award(db, sid, *, recipient=None, amount=None, signed=None, desc=None, agency=None):
    return db.execute(
        "INSERT INTO awards (recipient_id, agency_id, amount, signed_at, description, source,"
        " source_id, url) VALUES (%s, %s, %s, %s, %s, 't', %s, %s) RETURNING id",
        (recipient, agency, amount, signed, desc, sid, f"https://example.gov/{sid}"),
    ).fetchone()[0]


@pytest.mark.db
def test_get_org_awards_follows_merges_and_edges(db):
    army = db.execute(
        "INSERT INTO organizations (canonical_name, kind, source, source_id)"
        " VALUES ('Department of the Army', 'agency', 't', 'army') RETURNING id"
    ).fetchone()[0]
    canon = _org(db, "Sikorsky Aircraft Corporation", "a", uei="UTJWTSLMFNG4")
    merged = _org(db, "SIKORSKY AIRCRAFT CORP", "b", merged_into=canon)
    other = _org(db, "Boeing Sikorsky Aircraft Support", "c")
    a1 = _award(
        db, "1", recipient=canon, amount=100, signed="2026-01-05", desc="UH-60", agency=army
    )
    a2 = _award(db, "2", recipient=merged, amount=50, signed="2026-03-01", desc="x" * 500)
    a3 = _award(db, "3", amount=7, signed="2025-12-01", desc="multi-award")  # via edge only
    db.execute(
        "INSERT INTO edges (src_type, src_id, rel, dst_type, dst_id, source, source_id)"
        " VALUES ('award', %s, 'awarded_to', 'organization', %s, 't', 'e1')",
        (a3, merged),
    )
    _award(db, "4", recipient=other, amount=999, signed="2026-06-01", desc="not ours")
    before = db.execute("SELECT count(*) FROM awards").fetchone()[0]

    ctx = make_ctx(db)
    for org_id in (canon, merged):  # asking about a merged row answers for the canonical one
        out = tools.get_org_awards(ctx, org_id)
        assert out.org_id == org_id and out.canonical_org_id == canon
        assert out.name == "Sikorsky Aircraft Corporation" and out.uei == "UTJWTSLMFNG4"
        assert [a.award_id for a in out.awards] == [a2, a1, a3]  # most recent first
        assert out.total_awards == 3 and out.total_amount == 157.0
    assert out.awards[1].agency == "Department of the Army" and out.awards[1].amount == 100.0
    assert len(out.awards[0].description) == tools.DESCRIPTION_CHARS

    # limit is clamped, totals still cover everything
    one = tools.get_org_awards(ctx, canon, limit=1)
    assert len(one.awards) == 1 and one.total_awards == 3
    assert len(tools.get_org_awards(ctx, canon, limit=-5).awards) == 1
    assert len(tools.get_org_awards(ctx, canon, limit=10_000).awards) == 3

    # Context cost: a full page of long awards stays small, because every tool
    # result is re-sent to the model on each later request.
    for i in range(30):
        _award(db, f"bulk{i}", recipient=canon, amount=1, signed="2024-01-01", desc="y" * 900)
    before += 30
    big = tools.get_org_awards(ctx, canon, limit=10_000)
    assert len(big.awards) == tools.AWARDS_MAX_LIMIT == 10 and big.total_awards == 33
    assert len(tools.get_org_awards(ctx, canon).awards) == tools.AWARDS_DEFAULT_LIMIT == 5
    assert len(big.model_dump_json()) < 4000  # about 1k tokens

    empty = tools.get_org_awards(ctx, army)
    assert empty.total_awards == 0 and empty.awards == [] and empty.total_amount is None

    with pytest.raises(ModelRetry, match="No organization"):
        tools.get_org_awards(ctx, 999_999)
    assert db.execute("SELECT count(*) FROM awards").fetchone()[0] == before  # read-only


# --- addresses ---------------------------------------------------------------


@pytest.mark.parametrize(
    "a,b,verdict",
    [
        # same place, different formatting
        ("6900 Main Street, Stratford, CT 06614-1378", "6900 MAIN ST, STRATFORD, CT 06614", "same"),
        (
            "6900 Main St., Stratford, Connecticut 06614, USA",
            "6900 MAIN ST STRATFORD CT 06614",
            "same",
        ),
        (
            "1 North Park Avenue, Suite 200, Dayton, OH 45402",
            "1 N PARK AVE STE 200, DAYTON, OH 45402",
            "same",
        ),
        ("P.O. Box 12, Dayton, OH 45402", "PO BOX 12, DAYTON, OH 45402", "same"),
        # a bare street line names no place: Main St in which town?
        ("100 Main St", "100 MAIN STREET", "unclear"),
        # one side omits its suite: not a conflict
        ("1 N Park Ave, Dayton, OH 45402", "1 N PARK AVE STE 200, DAYTON, OH 45402", "same"),
        # suite differences
        (
            "1 N Park Ave #200, Dayton, OH 45402",
            "1 N Park Ave Suite 310, Dayton, OH 45402",
            "same_building_different_unit",
        ),
        # same street line, different cities
        ("100 Main St, Springfield, IL 62701", "100 Main St, Springfield, MA 01103", "different"),
        (
            "6900 Main St, Stratford, CT 06614",
            "7244B Nightstalker Way, Fort Campbell, KY 42223",
            "different",
        ),
        ("100 Main St, Dayton, OH 45402", "102 Main St, Dayton, OH 45402", "different"),
        # close but not identical: left to the agent
        ("100 N Main St, Dayton, OH 45402", "100 Main St, Dayton, OH 45402", "unclear"),
    ],
)
def test_compare_addresses(a, b, verdict):
    out = tools.compare_addresses(a, b)
    assert out.verdict == verdict, out
    assert tools.compare_addresses(b, a).verdict == verdict  # symmetric
    assert 0 <= out.similarity <= 1


@pytest.mark.parametrize(
    "a,b,verdict",
    [
        # --- must never be a confident "same" (each of these used to be) ---
        # no street line at all: two records in the same town
        ("STRATFORD, CT 06614", "STRATFORD, CT 06614", "unclear"),
        # same street line, different city, no ZIP to say otherwise
        ("100 Main St, Springfield, IL", "100 Main St, Chicago, IL", "different"),
        ("100 Main St, Springfield, MO 65801", "100 Main St, Kansas City, MO", "different"),
        ("100 Main St Dayton OH", "100 Main St Columbus OH", "different"),
        ("100 Main St, London, UK", "100 Main St, Dayton, OH 45402", "different"),
        # one side has no place at all
        ("100 Main St", "100 Main St, Dallas, TX 75001", "unclear"),
        # unit first: the street is the next segment, and those differ
        (
            "Suite 200, 6900 Main St, Stratford, CT 06614",
            "Suite 200, 10 Elm St, Stratford, CT 06614",
            "different",
        ),
        (
            "Bldg 7, 100 Main St, Dayton, OH 45402",
            "Bldg 7, 5 Oak Rd, Dayton, OH 45402",
            "different",
        ),
        # placeholders are not addresses
        ("N/A", "N/A", "unclear"),
        ("unknown", "unknown", "unclear"),
        ("N/A", "100 Main St, Dayton, OH 45402", "unclear"),
        # --- must not be a confident "different" (each of these used to be) ---
        # "Washington" is the city here, not the state
        ("100 Main St, Washington", "100 Main St, Washington, DC 20001", "unclear"),
        # a 5-digit box or house number is not a ZIP
        ("PO Box 12345, Dayton, OH", "PO Box 12345, Dayton, OH 45402", "same"),
        (
            "Lockheed Martin, 12345 Main St, Dallas, TX",
            "12345 Main St, Dallas, TX 75001",
            "same",
        ),
        # --- legitimately the same place ---
        # leading zero of the ZIP lost in a numeric column
        ("6900 MAIN ST, STRATFORD, CT 6614", "6900 Main St, Stratford, CT 06614", "same"),
        # unit first on one side only
        (
            "Suite 200, 6900 Main St, Stratford, CT 06614",
            "6900 Main St Ste 200, Stratford, CT 06614",
            "same",
        ),
        # ZIPs match; a differently written city does not override that
        (
            "1 Lockheed Blvd, Ft Worth, TX 76108",
            "One Lockheed Boulevard, Fort Worth, TX 76108",
            "same",
        ),
        # --- still correctly different ---
        ("PO Box 12, Dayton, OH 45402", "PO Box 99, Dayton, OH 45402", "different"),
    ],
)
def test_compare_addresses_is_conservative(a, b, verdict):
    out = tools.compare_addresses(a, b)
    assert out.verdict == verdict, out
    assert tools.compare_addresses(b, a).verdict == verdict  # symmetric


def test_same_requires_numbered_street_and_confirmed_place():
    out = tools.compare_addresses("100 Main St, Springfield, IL", "100 Main St, Chicago, IL")
    assert out.same_street is True and out.same_city is False and out.same_state is True
    town = tools.compare_addresses("STRATFORD, CT 06614", "STRATFORD, CT 06614")
    assert town.same_street is False and town.same_zip is True and town.similarity == 1.0
    p = addresses.parse("Suite 200, 6900 Main St, Stratford, CT 06614")
    assert (p.street, p.street_number, p.unit, p.city) == (
        "6900 MAIN ST",
        "6900",
        "200",
        "STRATFORD",
    )
    assert addresses.parse("PO Box 12345, Dayton, OH").zip5 is None
    assert addresses.parse("PO Box 12345, Dayton, OH").street_number == "12345"
    assert addresses.parse("Lockheed Martin, 12345 Main St, Dallas, TX").zip5 is None
    washington = addresses.parse("100 Main St, Washington")
    assert washington.state is None and washington.city == "WASHINGTON"
    assert addresses.parse("100 Main St, Seattle, Washington").state == "WA"
    assert addresses.parse("100 Main St Dayton OH").city == "DAYTON"
    assert addresses.parse("n/a").placeholder and addresses.parse("  ").placeholder
    assert not addresses.parse("100 Main St").placeholder


def test_address_parsing_details():
    p = addresses.parse("1 North Park Avenue, Suite 200, Dayton, Ohio 45402-1234, United States")
    assert (p.street, p.unit, p.state, p.zip5) == ("1 N PARK AVE", "200", "OH", "45402")
    assert p.city == "DAYTON" and p.street_number == "1"
    assert p.normalized == "1 N PARK AVE, UNIT 200, DAYTON, OH, 45402"
    assert addresses.parse("12345 Oak Court").zip5 is None  # leading house number is not a ZIP
    assert addresses.parse("12 Oak Ct").state is None  # a court, not Connecticut
    assert addresses.parse("5 Elm St, Charleston, West Virginia 25301").state == "WV"
    out = tools.compare_addresses("5 Elm St, Reston, VA 20190", "5 Elm St, Reston, VA")
    assert out.same_zip is None and out.same_state is True and out.verdict == "same"
    with pytest.raises(ModelRetry):
        tools.compare_addresses("", "5 Elm St")


# --- registration with an agent ----------------------------------------------


@pytest.mark.db
def test_tools_register_and_run_through_an_agent(db):
    org = _org(db, "Acme Robotics", "acme")
    infos = []

    def script(messages, info):
        infos.append(info)
        if len(messages) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart("get_org_awards", {"org_id": org, "limit": 3}),
                    ToolCallPart(
                        "compare_addresses",
                        {"a": "1 Main St, Dayton, OH 45402", "b": "1 Main Street, Dayton, Ohio"},
                    ),
                    ToolCallPart("lookup_sam_entity", {"uei": "UTJWTSLMFNG4"}),
                    ToolCallPart("search_usaspending_recipient", {"name": "SIKORSKY AIRCRAFT"}),
                ]
            )
        return ModelResponse(parts=[TextPart("done")])

    seen = []
    ctx = make_ctx(db, seen)
    agent = Agent(FunctionModel(script), deps_type=ResolveDeps, tools=tools.TOOLS)
    result = agent.run_sync("go", deps=ctx.deps)
    assert result.output == "done" and result.usage.tool_calls == 4

    returns = {
        p.tool_name: p.content
        for m in result.all_messages()
        for p in m.parts
        if isinstance(p, ToolReturnPart)
    }
    assert returns["get_org_awards"].name == "Acme Robotics"
    assert returns["compare_addresses"].verdict == "same"
    assert returns["lookup_sam_entity"].status == "ok"
    assert returns["search_usaspending_recipient"].status == "ok"
    assert len(seen) == 5  # 1 SAM + 1 search + 3 details, all through the polite client

    defs = {t.name: t for t in infos[0].function_tools}
    assert set(defs) == {
        "lookup_sam_entity",
        "search_usaspending_recipient",
        "get_org_awards",
        "compare_addresses",
    }
    # Docstrings became descriptions, Args became parameter descriptions, ctx is hidden.
    sam = defs["lookup_sam_entity"]
    assert "SAM.gov" in sam.description
    assert set(sam.parameters_json_schema["properties"]) == {"uei", "name"}
    assert "12-character" in sam.parameters_json_schema["properties"]["uei"]["description"]
    assert defs["get_org_awards"].sequential and not defs["compare_addresses"].sequential
    assert [t.sequential for t in tools.TOOLS] == [True, True, True, False]
