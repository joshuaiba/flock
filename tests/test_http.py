import httpx
import pytest

from pipeline.http import PoliteClient, redact_url, user_agent


def make_client(handler, sleeps):
    return PoliteClient(
        transport=httpx.MockTransport(handler), sleep=sleeps.append, min_interval=0.0
    )


def test_user_agent_is_descriptive(monkeypatch):
    monkeypatch.delenv("FLOCK_CONTACT", raising=False)
    assert user_agent().startswith("flock/")
    monkeypatch.setenv("FLOCK_CONTACT", "ops@example.org")
    assert "ops@example.org" in user_agent()


@pytest.mark.parametrize("status", [429, 500, 503])
def test_retries_then_succeeds(status):
    calls, sleeps = [], []

    def handler(req):
        calls.append(req)
        return httpx.Response(status if len(calls) < 3 else 200, json={})

    with make_client(handler, sleeps) as c:
        assert c.get("https://example.gov/x").status_code == 200
    assert len(calls) == 3
    assert len(sleeps) == 2 and sleeps[1] > sleeps[0] * 0.9  # backoff grows (with jitter)
    assert calls[0].headers["User-Agent"].startswith("flock/")


def test_honors_retry_after():
    sleeps, n = [], []

    def handler(req):
        n.append(1)
        if len(n) == 1:
            return httpx.Response(429, headers={"Retry-After": "7"})
        return httpx.Response(200)

    with make_client(handler, sleeps) as c:
        c.get("https://example.gov/x")
    assert sleeps == [7.0]


def test_gives_up_and_returns_last_response():
    sleeps = []
    with make_client(lambda req: httpx.Response(503), sleeps) as c:
        c.max_retries = 2
        assert c.get("https://example.gov/x").status_code == 503
    assert len(sleeps) == 2


def test_no_retry_on_4xx():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(403)

    with make_client(handler, []) as c:
        assert c.get("https://example.gov/x").status_code == 403
    assert len(calls) == 1


def test_throttles_same_host():
    sleeps = []
    c = PoliteClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200)),
        sleep=sleeps.append,
        min_interval=5.0,
    )
    c.get("https://a.gov/1")
    c.get("https://a.gov/2")
    c.get("https://b.gov/1")
    assert len(sleeps) == 1 and 4.0 < sleeps[0] <= 5.0


def test_retry_warnings_do_not_log_query_string_secrets(caplog):
    """SAM.gov takes its key as ?api_key=; neither retry warning may print it."""
    calls = []

    def flaky(req):
        calls.append(req)
        if len(calls) == 1:
            raise httpx.ConnectError(f"cannot connect to {req.url}")
        return httpx.Response(503 if len(calls) == 2 else 200)

    with caplog.at_level("WARNING", logger="pipeline.http"), make_client(flaky, []) as c:
        resp = c.get("https://api.example.gov/x?api_key=sekret-123&q=acme&token=t0p")
    assert resp.status_code == 200 and len(calls) == 3
    assert "api_key=sekret-123" in str(calls[0].url)  # the request itself is untouched
    warnings = [r.getMessage() for r in caplog.records if r.name == "pipeline.http"]
    assert len(warnings) == 2 and all("retrying" in w for w in warnings)
    assert "sekret-123" not in caplog.text and "t0p" not in caplog.text
    assert "api_key=REDACTED" in caplog.text and "q=acme" in caplog.text


def test_redact_url():
    assert redact_url("https://x/y?a=1&api_key=abc&b=2") == "https://x/y?a=1&api_key=REDACTED&b=2"
    assert redact_url("GET https://x/y?key=abc failed") == "GET https://x/y?key=REDACTED failed"
    assert redact_url("https://x/y?q=monkey") == "https://x/y?q=monkey"
