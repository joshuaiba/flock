"""Audit trail and cost tracker: one `agent_runs` row per agent run.

    with run_log.bind(conn):
        result = run_log.run_logged(agent, prompt, agent_name="resolver",
                                    input_ref="org:1|org:2", model_label="gemini:...")

Independent of Logfire. If no connection is bound or passed, the agent still
runs and nothing is logged (extraction must work without a database).

Commit expectations: the row is inserted inside `conn.transaction()`. If the
connection is idle, that is a transaction of its own and the row is committed
immediately. If the caller already has a transaction open, it is a savepoint
and the row is committed with the caller's transaction, so a caller that wants
failed runs kept must catch the re-raised exception *inside* its transaction
block rather than letting it roll the block back.
"""

from __future__ import annotations

import contextvars
import logging
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel
from pydantic_ai import Agent, capture_run_messages
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai.run import AgentRunResult

from pipeline.agents.settings import get_settings

log = logging.getLogger(__name__)

REDACTED = "REDACTED"
# Pydantic AI's output tool(s) are named final_result / final_result_<Type>;
# they carry the answer, not a tool call worth auditing.
OUTPUT_TOOL_PREFIX = "final_result"

_conn: contextvars.ContextVar[psycopg.Connection | None] = contextvars.ContextVar(
    "agent_run_log_conn", default=None
)

_last_run_id: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "agent_run_log_last_id", default=None
)

_SECRET_PARAM = re.compile(
    r"(?i)\b((?:api[_-]?key|key|token|access_token|secret|password)=)[^&\s\"'<>]+"
)
_AUTH_HEADER = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}")


@contextmanager
def bind(conn: psycopg.Connection) -> Iterator[psycopg.Connection]:
    """Log every run_logged() call in this context to `conn`."""
    token = _conn.set(conn)
    try:
        yield conn
    finally:
        _conn.reset(token)


def current_conn() -> psycopg.Connection | None:
    return _conn.get()


def redact(text: str) -> str:
    """Strip API keys from a string or URL: key-like query params, auth headers,
    and the literal value of every configured secret."""
    out = _SECRET_PARAM.sub(rf"\1{REDACTED}", text)
    out = _AUTH_HEADER.sub(rf"\1 {REDACTED}", out)
    for secret in get_settings().secret_values():
        if secret:
            out = out.replace(secret, REDACTED)
    return out


def redact_value(value: Any) -> Any:
    """redact() applied recursively to the strings in a JSON-like value."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: redact_value(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [redact_value(v) for v in value]
    return value


def tool_calls_from(messages: list[ModelMessage]) -> list[dict]:
    """[{tool_name, args}] for every function tool the model called, in order."""
    out = []
    for message in messages:
        if not isinstance(message, ModelResponse):
            continue
        for part in message.parts:
            if isinstance(part, ToolCallPart) and not part.tool_name.startswith(OUTPUT_TOOL_PREFIX):
                try:
                    args: Any = part.args_as_dict()
                except Exception:  # malformed JSON args from the model
                    args = part.args
                out.append({"tool_name": part.tool_name, "args": redact_value(args)})
    return out


def _usage_from(messages: list[ModelMessage]) -> tuple[int, int, int]:
    """(requests, input_tokens, output_tokens) summed from captured responses."""
    responses = [m for m in messages if isinstance(m, ModelResponse)]
    return (
        len(responses),
        sum(r.usage.input_tokens or 0 for r in responses),
        sum(r.usage.output_tokens or 0 for r in responses),
    )


def record(
    conn: psycopg.Connection,
    *,
    agent_name: str,
    input_ref: str | None,
    model: str,
    status: str,
    requests: int,
    input_tokens: int,
    output_tokens: int,
    tool_calls: list[dict],
    output: Any,
    error: str | None,
    started_at: datetime,
    finished_at: datetime,
) -> int:
    """Insert one agent_runs row and return its id. See module docstring for commit rules."""
    with conn.transaction():
        return conn.execute(
            """INSERT INTO agent_runs (agent_name, input_ref, model, status, requests,
                                       input_tokens, output_tokens, tool_calls, output, error,
                                       started_at, finished_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                agent_name,
                input_ref,
                model,
                status,
                requests,
                input_tokens,
                output_tokens,
                Jsonb(tool_calls),
                Jsonb(output) if output is not None else None,
                error,
                started_at,
                finished_at,
            ),
        ).fetchone()[0]


def _dump_output(output: Any) -> Any:
    if isinstance(output, BaseModel):
        return redact_value(output.model_dump(mode="json"))
    if isinstance(output, str | int | float | bool | list | dict):
        return redact_value(output)
    return None


def run_logged[OutputT](
    agent: Agent[Any, OutputT],
    user_prompt: str,
    *,
    agent_name: str,
    input_ref: str | None,
    model_label: str,
    conn: psycopg.Connection | None = None,
    **run_kwargs: Any,
) -> AgentRunResult[OutputT]:
    """agent.run_sync(user_prompt, **run_kwargs), recorded as one agent_runs row.

    On success the row has status 'ok' with usage, tool calls and the output.
    On any exception (model error, budget exceeded, retries exhausted) the row
    has status 'failed' with the redacted error and whatever tool calls and
    usage happened before the failure; the original exception is re-raised.
    The id of the row written is available as `last_run_id()` afterwards.
    """
    conn = conn or current_conn()
    _last_run_id.set(None)
    if conn is None:
        return agent.run_sync(user_prompt, **run_kwargs)

    started = datetime.now(UTC)
    with capture_run_messages() as messages:
        try:
            result = agent.run_sync(user_prompt, **run_kwargs)
        except Exception as e:
            requests, input_tokens, output_tokens = _usage_from(messages)
            _write(
                conn,
                agent_name=agent_name,
                input_ref=input_ref,
                model=model_label,
                status="failed",
                requests=requests,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                tool_calls=tool_calls_from(messages),
                output=None,
                error=redact(f"{type(e).__name__}: {e}"),
                started_at=started,
                finished_at=datetime.now(UTC),
            )
            raise
    usage = result.usage
    _write(
        conn,
        agent_name=agent_name,
        input_ref=input_ref,
        model=model_label,
        status="ok",
        requests=usage.requests,
        input_tokens=usage.input_tokens or 0,
        output_tokens=usage.output_tokens or 0,
        tool_calls=tool_calls_from(result.all_messages()),
        output=_dump_output(result.output),
        error=None,
        started_at=started,
        finished_at=datetime.now(UTC),
    )
    return result


def last_run_id() -> int | None:
    """agent_runs.id written by the most recent run_logged() in this context, if any."""
    return _last_run_id.get()


def _write(conn: psycopg.Connection, **row: Any) -> None:
    try:
        _last_run_id.set(record(conn, **row))
    except psycopg.Error as e:  # the audit log must not turn a good run into a failure
        log.error("could not write agent_runs row for %s: %s", row.get("agent_name"), e)
