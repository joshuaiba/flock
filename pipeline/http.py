"""Polite HTTP client shared by all ingestors.

- Descriptive User-Agent (optionally with FLOCK_CONTACT appended).
- Sequential by design: one request at a time, with a minimum interval
  between requests to the same host. Never parallelize against a single
  government host.
- Retries 429 and 5xx (and transport errors) with exponential backoff,
  honoring Retry-After when present.
"""

from __future__ import annotations

import logging
import os
import random
import re
import time
from collections.abc import Callable
from email.utils import parsedate_to_datetime

import httpx

from pipeline import __version__

log = logging.getLogger(__name__)

RETRY_STATUSES = {429, 500, 502, 503, 504}

# Query-string secrets (SAM.gov takes its key as ?api_key=). Kept local so this
# module does not depend on pipeline.agents.
_SECRET_PARAM = re.compile(
    r"(?i)\b((?:api[_-]?key|key|token|access_token|secret|password)=)[^&\s\"'<>)]+"
)


def redact_url(text: object) -> str:
    """`text` with the value of any key-like query parameter replaced."""
    return _SECRET_PARAM.sub(r"\1REDACTED", str(text))


def user_agent() -> str:
    ua = f"flock/{__version__} (defense autonomy funding research pipeline; python-httpx)"
    if contact := os.environ.get("FLOCK_CONTACT", "").strip():
        ua = f"{ua[:-1]}; {contact})"
    return ua


def _retry_after_seconds(resp: httpx.Response) -> float | None:
    value = resp.headers.get("Retry-After")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
        except (TypeError, ValueError):
            return None


class PoliteClient:
    def __init__(
        self,
        *,
        min_interval: float = 1.0,
        max_retries: int = 5,
        backoff_base: float = 2.0,
        backoff_cap: float = 120.0,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        headers: dict[str, str] | None = None,
    ):
        self.min_interval = min_interval
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_cap = backoff_cap
        self._sleep = sleep
        self._last_request: dict[str, float] = {}
        self._client = httpx.Client(
            headers={"User-Agent": user_agent(), **(headers or {})},
            timeout=timeout,
            transport=transport,
            follow_redirects=True,
        )

    def __enter__(self) -> PoliteClient:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _throttle(self, host: str) -> None:
        last = self._last_request.get(host)
        if last is not None:
            wait = self.min_interval - (time.monotonic() - last)
            if wait > 0:
                self._sleep(wait)
        self._last_request[host] = time.monotonic()

    def _backoff(self, attempt: int) -> float:
        delay = min(self.backoff_cap, self.backoff_base * 2**attempt)
        return delay * (0.5 + random.random() / 2)

    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        host = httpx.URL(url).host
        for attempt in range(self.max_retries + 1):
            self._throttle(host)
            try:
                resp = self._client.request(method, url, **kwargs)
            except httpx.TransportError as e:
                if attempt == self.max_retries:
                    raise
                delay = self._backoff(attempt)
                log.warning(
                    "%s %s failed (%s); retrying in %.1fs",
                    method,
                    redact_url(url),
                    redact_url(e),
                    delay,
                )
                self._sleep(delay)
                continue
            if resp.status_code not in RETRY_STATUSES or attempt == self.max_retries:
                return resp
            delay = _retry_after_seconds(resp)
            delay = self._backoff(attempt) if delay is None else min(delay, self.backoff_cap)
            log.warning(
                "%s %s -> %s; retrying in %.1fs", method, redact_url(url), resp.status_code, delay
            )
            self._sleep(delay)
        raise AssertionError("unreachable")

    def get(self, url: str, **kwargs) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs) -> httpx.Response:
        return self.request("POST", url, **kwargs)
