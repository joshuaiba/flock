import httpx
import pytest

from pipeline.http import PoliteClient, user_agent


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
