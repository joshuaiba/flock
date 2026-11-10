import pytest
from pydantic import BaseModel

from pipeline.extract import llm
from pipeline.extract.contract_announcement import ContractAnnouncement
from pipeline.extract.gemini import GeminiProvider, to_gemini_schema
from tests.fakes import FakeProvider


class Thing(BaseModel):
    name: str
    count: int | None


def test_extract_validates_and_wraps_text():
    p = FakeProvider(lambda prompt, schema: {"name": "x", "count": 2})
    assert llm.extract("hello world", Thing, instructions="Find things.", provider=p) == Thing(
        name="x", count=2
    )
    prompt, schema = p.calls[0]
    assert prompt.startswith("Find things.") and "<text>\nhello world\n</text>" in prompt
    assert schema == Thing.model_json_schema()


def test_extract_retries_once_then_raises():
    p = FakeProvider(lambda prompt, schema: "not json")
    with pytest.raises(llm.ExtractionError):
        llm.extract("t", Thing, provider=p)
    assert len(p.calls) == 2


def test_extract_recovers_on_second_attempt():
    replies = iter(['{"name": 1}', '{"name": "ok", "count": null}'])
    p = FakeProvider(lambda prompt, schema: next(replies))
    assert llm.extract("t", Thing, provider=p).name == "ok"


def test_gemini_schema_is_flat_and_nullable():
    s = to_gemini_schema(ContractAnnouncement.model_json_schema())
    text = repr(s)
    assert "$ref" not in text and "$defs" not in text and "anyOf" not in text
    assert s["properties"]["amount_usd"]["type"] == ["number", "null"]
    assert s["properties"]["completion_date"] == {
        **s["properties"]["completion_date"],
        "type": ["string", "null"],
        "format": "date",
    }
    awardee = s["properties"]["awardees"]["items"]
    assert awardee["type"] == "object"
    assert set(awardee["required"]) == {
        "contractor",
        "location",
        "contract_number",
        "small_business",
    }
    assert set(s["required"]) == set(s["properties"])


class _Err(Exception):
    def __init__(self, status_code):
        super().__init__(f"status {status_code}")
        self.status_code = status_code


class _FakeInteractions:
    def __init__(self, outcomes):
        self.outcomes, self.kwargs = list(outcomes), []

    def create(self, **kwargs):
        self.kwargs.append(kwargs)
        o = self.outcomes.pop(0)
        if isinstance(o, Exception):
            raise o
        return type("Interaction", (), {"output_text": o})()


def _gemini(outcomes):
    fake = type("Client", (), {})()
    fake.interactions = _FakeInteractions(outcomes)
    sleeps = []
    prov = GeminiProvider(client=fake, model="m", min_interval=0, sleep=sleeps.append)
    return prov, fake.interactions, sleeps


def test_gemini_request_shape_and_retry_on_429():
    prov, calls, sleeps = _gemini([_Err(429), _Err(503), '{"name": "a", "count": 1}'])
    assert llm.extract("t", Thing, provider=prov).name == "a"
    assert len(calls.kwargs) == 3 and len(sleeps) == 2
    kw = calls.kwargs[0]
    assert kw["model"] == "m"
    assert kw["response_format"]["type"] == "text"
    assert kw["response_format"]["mime_type"] == "application/json"
    assert prov.name == "gemini:m"


def test_gemini_does_not_retry_client_errors():
    prov, calls, _ = _gemini([_Err(400)])
    with pytest.raises(_Err):
        prov.generate_json("p", Thing.model_json_schema())
    assert len(calls.kwargs) == 1
