import json

from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from pipeline.extract.llm import Provider


def first_user_prompt(messages) -> str:
    """The run's original user prompt (later ones are Pydantic AI's retry feedback)."""
    for message in messages:
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if isinstance(part, UserPromptPart):
                    return part.content
    raise AssertionError("no user prompt in messages")


class FakeProvider(Provider):
    """Deterministic stand-in for the LLM: a Provider wrapping a FunctionModel.

    `responder(prompt, info) -> dict | str` builds each response, where `prompt`
    is the user prompt ("<text>\\n...\\n</text>") and `info` is Pydantic AI's
    AgentInfo (info.instructions, output schema, ...). Every model request is
    recorded in `calls`, including retries.
    """

    def __init__(self, responder, name: str = "fake:test"):
        self.responder = responder
        self.calls: list[tuple[str, AgentInfo]] = []
        super().__init__(
            name=name, model=FunctionModel(self._respond), min_interval=0.0, sleep=lambda s: None
        )

    def _respond(self, messages, info: AgentInfo) -> ModelResponse:
        prompt = first_user_prompt(messages)
        self.calls.append((prompt, info))
        out = self.responder(prompt, info)
        return ModelResponse(parts=[TextPart(out if isinstance(out, str) else json.dumps(out))])


def text_of(prompt: str) -> str:
    """The text between the <text> tags of a user prompt."""
    return prompt.split("<text>\n", 1)[1].rsplit("\n</text>", 1)[0]
