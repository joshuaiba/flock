import pytest
from pydantic import BaseModel
from pydantic_ai import ModelRetry
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from pipeline.agents import run_log, settings
from pipeline.extract import llm
from pipeline.extract.contract_announcement import (
    ContractAnnouncement,
    normalize_contract_number,
    plausible_contract_number,
)
from tests.fakes import FakeProvider


class Thing(BaseModel):
    name: str
    count: int | None


def announcement(**over) -> dict:
    return {
        "awardees": [
            {
                "contractor": "Acme Corp.",
                "location": "Dayton, Ohio",
                "contract_number": None,
                "small_business": False,
            }
        ],
        "amount_usd": 1e7,
        "amount_type": "obligation",
        "contract_number": "FA8604-25-D-B001",
        "awarding_office": None,
        "description": "Stuff.",
        "completion_date": None,
        "is_modification": False,
        **over,
    }


def test_extract_validates_and_wraps_text():
    p = FakeProvider(lambda prompt, info: {"name": "x", "count": 2})
    assert llm.extract("hello world", Thing, instructions="Find things.", provider=p) == Thing(
        name="x", count=2
    )
    prompt, info = p.calls[0]
    assert prompt == "<text>\nhello world\n</text>"
    # Task instructions first, then the data-framing sentence (the pre-refactor order).
    assert info.instructions == f"Find things.\n\n{llm.DATA_FRAMING}"
    # Native structured output: the schema is the response format, not a tool.
    assert info.output_tools == [] and info.function_tools == []
    assert info.model_request_parameters.output_object.json_schema["properties"].keys() == {
        "name",
        "count",
    }


def test_extract_retries_once_then_raises():
    p = FakeProvider(lambda prompt, info: "not json")
    with pytest.raises(llm.ExtractionError, match="fake:test"):
        llm.extract("t", Thing, provider=p)
    assert len(p.calls) == 2


def test_extract_recovers_on_second_attempt():
    replies = iter(['{"name": 1}', '{"name": "ok", "count": null}'])
    p = FakeProvider(lambda prompt, info: next(replies))
    assert llm.extract("t", Thing, provider=p).name == "ok"
    assert len(p.calls) == 2


def test_max_attempts_one_means_no_retry():
    p = FakeProvider(lambda prompt, info: "not json")
    with pytest.raises(llm.ExtractionError):
        llm.extract("t", Thing, provider=p, max_attempts=1)
    assert len(p.calls) == 1


def test_budget_caps_requests_even_with_more_attempts():
    p = FakeProvider(lambda prompt, info: "not json")
    with pytest.raises(llm.ExtractionError):
        llm.extract("t", Thing, provider=p, max_attempts=5)
    assert len(p.calls) == 2  # EXTRACT_REQUEST_LIMIT


def test_registered_validator_gets_one_retry():
    class Positive(BaseModel):
        n: int

    def check(out: Positive) -> None:
        if out.n < 0:
            raise ModelRetry("n must be >= 0")

    llm.register_validator(Positive, check)
    replies = iter([{"n": -1}, {"n": 3}])
    p = FakeProvider(lambda prompt, info: next(replies))
    assert llm.extract("t", Positive, provider=p).n == 3

    always_bad = FakeProvider(lambda prompt, info: {"n": -1})
    with pytest.raises(llm.ExtractionError):
        llm.extract("t", Positive, provider=always_bad)
    assert len(always_bad.calls) == 2


@pytest.mark.parametrize(
    "bad",
    [
        {"amount_usd": -5.0},
        {"contract_number": "N/A"},
        {"contract_number": "see paragraph above"},
        {"awardees": []},
    ],
)
def test_contract_announcement_bad_values_trigger_retry(bad):
    replies = iter([announcement(**bad), announcement()])
    p = FakeProvider(lambda prompt, info: next(replies))
    out = llm.extract("t", ContractAnnouncement, provider=p)
    assert out.amount_usd == 1e7 and out.contract_number == "FA8604-25-D-B001"
    assert len(p.calls) == 2


@pytest.mark.parametrize("bad", [{"amount_usd": -5.0}, {"awardees": []}])
def test_hard_validations_still_fail_after_the_retry(bad):
    p = FakeProvider(lambda prompt, info: announcement(**bad))
    with pytest.raises(llm.ExtractionError):
        llm.extract("t", ContractAnnouncement, provider=p)
    assert len(p.calls) == 2


def test_bad_contract_number_is_nulled_after_the_retry_not_fatal(caplog):
    """A number the model can't get right must not cost us the award."""
    bad = announcement(contract_number="see paragraph above")
    bad["awardees"][0]["contract_number"] = "unknown"
    p = FakeProvider(lambda prompt, info: bad)
    with caplog.at_level("WARNING"):
        out = llm.extract("t", ContractAnnouncement, provider=p)
    assert len(p.calls) == 2  # the model still got its one chance to correct it
    assert out.contract_number is None and out.awardees[0].contract_number is None
    assert out.amount_usd == 1e7 and out.awardees[0].contractor == "Acme Corp."
    assert "see paragraph above" in caplog.text and "unknown" in caplog.text


def test_bad_contract_number_is_nulled_when_there_is_no_retry_left():
    p = FakeProvider(lambda prompt, info: announcement(contract_number="N/A"))
    out = llm.extract("t", ContractAnnouncement, provider=p, max_attempts=1)
    assert out.contract_number is None and len(p.calls) == 1
    # More attempts than the request budget allows: the budget's last request is final.
    p = FakeProvider(lambda prompt, info: announcement(contract_number="N/A"))
    out = llm.extract("t", ContractAnnouncement, provider=p, max_attempts=5)
    assert out.contract_number is None and len(p.calls) == 2


@pytest.mark.parametrize(
    "written,stored",
    [
        ("FA8626-22-D-0010 (P00005)", "FA8626-22-D-0010"),
        ("FA8626-22-D-0010, P00005", "FA8626-22-D-0010"),
        ("N0001921G0006 (order N0001924F0259)", "N0001921G0006"),
        ("N00019-21-G-0006; N00019-24-F-0259", "N00019-21-G-0006"),
        ("FA8604-25-D-B001.", "FA8604-25-D-B001"),
        ("W91278\u201125\u2011C\u20110017", "W91278-25-C-0017"),  # non-breaking hyphens
        ("W91278\u201325\u2013C\u20130017", "W91278-25-C-0017"),  # en dashes
        ("FA8626-22-D-0010 and FA8626-22-D-0011", "FA8626-22-D-0010"),
        ("contract FA8626-22-D-0010", "FA8626-22-D-0010"),
        ("(P00005) FA8626-22-D-0010", "FA8626-22-D-0010"),
        ("  n0042125f0043 ", "n0042125f0043"),
    ],
)
def test_contract_numbers_are_normalized_without_a_retry(written, stored):
    assert normalize_contract_number(written) == stored
    reply = announcement(contract_number=written)
    reply["awardees"][0]["contract_number"] = written
    p = FakeProvider(lambda prompt, info: reply)
    out = llm.extract("t", ContractAnnouncement, provider=p)
    assert out.contract_number == stored and out.awardees[0].contract_number == stored
    assert len(p.calls) == 1


@pytest.mark.parametrize(
    "number",
    [
        "FA8604-25-D-B001",
        "N0042125F0043",
        "HR001125CE032",
        "N00383-25-F-YY1T",
        "W9128F-25-C-A026",
        "FA8626-22-D-0010 P00012",
        "GS-35F-0119Y",
    ],
)
def test_real_contract_numbers_are_plausible(number):
    assert plausible_contract_number(number)


@pytest.mark.parametrize(
    "number",
    ["", "N/A", "none", "X-1", "the basic contract", "P00005", "PZ0001", "937-555-0100"],
)
def test_non_contract_numbers_are_not(number):
    assert not plausible_contract_number(number)
    assert normalize_contract_number(number) is None


def test_extraction_error_message_is_redacted(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "gm-secret-key-123456")
    settings.reset_settings()

    def respond(messages, info):
        raise ModelHTTPError(
            400, "m", body={"error": "bad key gm-secret-key-123456", "url": "/x?key=zzz999"}
        )

    p = llm.Provider(name="fake:test", model=FunctionModel(respond), min_interval=0)
    with pytest.raises(llm.ExtractionError) as e:
        llm.extract("t", Thing, provider=p)
    assert "gm-secret-key-123456" not in str(e.value) and "zzz999" not in str(e.value)
    assert "fake:test" in str(e.value) and "400" in str(e.value)


def _flaky_provider(statuses, sleeps):
    """A Provider whose model raises the given HTTP statuses, then answers."""
    statuses = list(statuses)

    def respond(messages, info):
        if statuses:
            raise ModelHTTPError(statuses.pop(0), "m")
        return ModelResponse(parts=[TextPart('{"name": "a", "count": 1}')])

    return llm.Provider(
        name="fake:flaky", model=FunctionModel(respond), min_interval=0.0, sleep=sleeps.append
    )


def test_provider_backs_off_on_429_and_5xx():
    sleeps = []
    p = _flaky_provider([429, 503], sleeps)
    assert llm.extract("t", Thing, provider=p).name == "a"
    assert len(sleeps) == 2 and sleeps[1] > sleeps[0] * 0.9


def test_provider_does_not_retry_client_errors():
    sleeps = []
    p = _flaky_provider([400], sleeps)
    with pytest.raises(llm.ExtractionError):
        llm.extract("t", Thing, provider=p)
    assert sleeps == []


def test_provider_paces_calls():
    sleeps = []
    p = _flaky_provider([], sleeps)
    p.min_interval = 5.0
    llm.extract("a", Thing, provider=p)
    llm.extract("b", Thing, provider=p)
    assert len(sleeps) == 1 and 4.0 < sleeps[0] <= 5.0


def test_default_provider_comes_from_settings(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("EXTRACT_MODEL", "gemini-x")
    settings.reset_settings()
    monkeypatch.setattr(llm, "_provider", None)
    p = llm.get_provider()
    assert p.name == "gemini:gemini-x" and p.model.model_name == "gemini-x"
    assert llm.get_provider() is p


def test_default_provider_requires_key(monkeypatch):
    monkeypatch.setattr(llm, "_provider", None)
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):  # the default model is Claude
        llm.get_provider()
    monkeypatch.setenv("EXTRACT_MODEL", "gemini-x")
    settings.reset_settings()
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        llm.get_provider()


def test_extract_without_db_logs_nothing():
    p = FakeProvider(lambda prompt, info: {"name": "x", "count": None})
    assert run_log.current_conn() is None
    assert llm.extract("t", Thing, provider=p).name == "x"
    assert run_log.last_run_id() is None


@pytest.mark.db
def test_extract_writes_agent_runs(db):
    ok = FakeProvider(lambda prompt, info: {"name": "x", "count": 1})
    bad = FakeProvider(lambda prompt, info: "not json")
    with run_log.bind(db):
        llm.extract("t", Thing, provider=ok, input_ref="award:7")
        with pytest.raises(llm.ExtractionError):
            llm.extract("t", Thing, provider=bad, input_ref="award:8")
    rows = db.execute(
        "SELECT agent_name, input_ref, model, status, requests, input_tokens, output_tokens,"
        " output, error FROM agent_runs ORDER BY id"
    ).fetchall()
    assert [r[:5] for r in rows] == [
        ("extract:Thing", "award:7", "fake:test", "ok", 1),
        ("extract:Thing", "award:8", "fake:test", "failed", 2),
    ]
    assert all(r[5] > 0 and r[6] > 0 for r in rows)
    assert rows[0][7] == {"name": "x", "count": 1} and rows[0][8] is None
    assert rows[1][7] is None and "UnexpectedModelBehavior" in rows[1][8]


DAILY_429 = {
    "error": {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "details": [
            {"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"},
            {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "6676s"},
        ],
    }
}


@pytest.mark.parametrize(
    "status,body,expected",
    [
        (429, DAILY_429, True),
        (429, {"error": {"details": [{"retryDelay": "900s"}]}}, True),
        (429, {"error": {"details": [{"retryDelay": "17.5s"}]}}, False),  # per-minute throttle
        (429, None, False),
        (503, DAILY_429, False),
    ],
)
def test_daily_quota_detection(status, body, expected):
    assert llm.daily_quota_exhausted(ModelHTTPError(status, "m", body)) is expected


def test_spent_daily_quota_is_not_retried_and_trips_the_provider():
    sleeps, requests = [], []

    def respond(messages, info):
        requests.append(1)
        raise ModelHTTPError(429, "m", DAILY_429)

    p = llm.Provider(
        name="fake:quota", model=FunctionModel(respond), min_interval=0.0, sleep=sleeps.append
    )
    with pytest.raises(llm.ExtractionError):
        llm.extract("a", Thing, provider=p)
    assert len(requests) == 1 and sleeps == [] and p.exhausted
    with pytest.raises(llm.ExtractionError):  # later calls fail without a request
        llm.extract("b", Thing, provider=p)
    assert len(requests) == 1
