"""Gemini provider for llm.extract, via the google-genai Interactions API.

Docs (read 2026-11-09): https://ai.google.dev/gemini-api/docs/structured-output
- client.interactions.create(model=..., input=..., response_format={
      "type": "text", "mime_type": "application/json", "schema": <JSON Schema>})
- result in `interaction.output_text`
- Supported schema subset: types incl. ["T", "null"], properties, required,
  enum, format (date), items, $defs/$ref. Docs recommend required + nullable
  over optional fields to keep the decoding grammar small.
- Rate limits are per project and per model tier (see AI Studio); exceeding
  them returns 429 RESOURCE_EXHAUSTED, so we pace calls and back off.
"""

from __future__ import annotations

import copy
import logging
import os
import random
import time
from collections.abc import Callable

log = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-3.8-flash"
RETRY_STATUSES = {429, 500, 502, 503, 504}


def to_gemini_schema(schema: dict) -> dict:
    """Pydantic JSON Schema -> the subset Gemini documents.

    Inlines $refs, turns `anyOf: [X, {type: null}]` into `type: [X, "null"]`,
    drops `default`, and marks every property required (nullable fields stay
    nullable).
    """
    defs = schema.get("$defs", {})

    def walk(node):
        if isinstance(node, list):
            return [walk(n) for n in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            ref = defs[node["$ref"].rsplit("/", 1)[-1]]
            merged = {**copy.deepcopy(ref), **{k: v for k, v in node.items() if k != "$ref"}}
            return walk(merged)
        out = {k: walk(v) for k, v in node.items() if k not in ("$defs", "default")}
        any_of = out.get("anyOf")
        if any_of and any(b == {"type": "null"} for b in any_of):
            rest = [b for b in any_of if b != {"type": "null"}]
            if len(rest) == 1 and isinstance(rest[0].get("type"), str):
                del out["anyOf"]
                out = {**rest[0], **out, "type": [rest[0]["type"], "null"]}
        if out.get("type") == "object" and "properties" in out:
            out["required"] = list(out["properties"])
        return out

    return walk(schema)


class GeminiProvider:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        min_interval: float = 1.0,
        max_attempts: int = 6,
        sleep: Callable[[float], None] = time.sleep,
        client=None,
    ):
        self.model = model or os.environ.get("GEMINI_MODEL", DEFAULT_MODEL)
        self.name = f"gemini:{self.model}"
        self.min_interval = min_interval
        self.max_attempts = max_attempts
        self._sleep = sleep
        self._last = 0.0
        if client is None:
            from google import genai

            key = api_key or os.environ.get("GEMINI_API_KEY")
            if not key:
                raise RuntimeError("GEMINI_API_KEY is not set")
            client = genai.Client(api_key=key)
        self._client = client

    def generate_json(self, prompt: str, json_schema: dict) -> str:
        response_format = {
            "type": "text",
            "mime_type": "application/json",
            "schema": to_gemini_schema(json_schema),
        }
        for attempt in range(self.max_attempts):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                self._sleep(wait)
            self._last = time.monotonic()
            try:
                interaction = self._client.interactions.create(
                    model=self.model, input=prompt, response_format=response_format
                )
                return interaction.output_text or ""
            except Exception as e:
                status = getattr(e, "status_code", None)
                if status not in RETRY_STATUSES or attempt == self.max_attempts - 1:
                    raise
                delay = min(120.0, 2.0 * 2**attempt) * (0.5 + random.random() / 2)
                log.warning("gemini %s; retrying in %.1fs", status, delay)
                self._sleep(delay)
        raise AssertionError("unreachable")
