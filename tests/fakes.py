import json


class FakeProvider:
    """Deterministic stand-in for an LLM provider.

    `responder(prompt, schema) -> dict | str` builds each response; calls are recorded.
    """

    name = "fake:test"

    def __init__(self, responder):
        self.responder = responder
        self.calls: list[tuple[str, dict]] = []

    def generate_json(self, prompt: str, json_schema: dict) -> str:
        self.calls.append((prompt, json_schema))
        out = self.responder(prompt, json_schema)
        return out if isinstance(out, str) else json.dumps(out)
