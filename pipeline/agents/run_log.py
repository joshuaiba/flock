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
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote, urlsplit

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

# Names that hold a secret, with any prefix: api_key, GEMINI_API_KEY, x-goog-api-key,
# client_secret, refresh_token, db_password. Must end the name, so that counters
# like input_tokens are left alone.
_SECRET_NAME = r"[\w-]*(?:api[_-]?key|token|secret|password|passwd)"
_NOT_IN_WORD = r"(?<![A-Za-z0-9_-])"
# name=value (query strings, env dumps). A bare `key=` counts here too.
_SECRET_ASSIGN = re.compile(
    rf"(?i){_NOT_IN_WORD}((?:{_SECRET_NAME}|key)[\"']?\s*=\s*[\"']?)[^&\s\"'<>,;)]+"
)
# name: value (headers, JSON, dict reprs). Only for unambiguous names, and only
# for token-like values, so prose such as "key: value pairs" or
# "Unexpected token: }" is untouched. Quoted values may be short.
_SECRET_COLON = re.compile(
    rf"(?i){_NOT_IN_WORD}({_SECRET_NAME}[\"']?\s*:\s*)"
    r"(?:([\"'])[^\"'\s]+\2|[A-Za-z0-9._~+/=-]{6,})"
)
# URL-encoded query strings nested inside another URL: key%3Dvalue%26...
_SECRET_ENCODED = re.compile(
    rf"(?i)(?:(?<=%3F)|(?<=%26)|(?<![A-Za-z0-9_-]))((?:{_SECRET_NAME}|key)%3D)"
    r"(?:(?!%26)[^&\s\"'<>])+"
)
# scheme://user:password@host
_URL_USERINFO = re.compile(r"(?<=://)([^/\s:@]+):[^/\s@]+@")
# "Authorization: <anything>" of any length, and bare "Bearer <long token>".
_AUTH_HEADER = re.compile(
    r"(?i)\b(authorization[\"']?\s*[:=]\s*[\"']?(?:(?:bearer|basic)\s+)?)[^\s\"',;]+"
)
# The token must contain a digit, so "basic ordering agreement" is left alone.
_AUTH_SCHEME = re.compile(
    r"(?i)\b(bearer|basic)\s+(?!REDACTED)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}"
)

# Secrets that live outside Settings but can show up in errors. Their literal
# values are redacted wherever they appear.
_ENV_SECRETS = ("BRIGHTDATA_API_KEY",)
_ENV_DSNS = ("DATABASE_URL", "TEST_DATABASE_URL")
# Placeholder passwords that are also ordinary words: replacing them everywhere
# would mangle text ("postgresql://", "password authentication failed"). The
# URL-userinfo rule still covers them where they actually appear in a DSN.
_TRIVIAL = {"password", "postgres", "secret", "changeme", "admin", "flock", "test"}
_MIN_LITERAL = 6


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


def _literal_secrets() -> list[str]:
    """Known secret values: configured settings secrets, plus BRIGHTDATA_API_KEY
    and the database password when present in the environment."""
    values = list(get_settings().secret_values())
    values += [os.environ.get(name, "").strip() for name in _ENV_SECRETS]
    for name in _ENV_DSNS:
        dsn = os.environ.get(name, "")
        try:
            password = urlsplit(dsn).password if "://" in dsn else None
        except ValueError:
            password = None
        if password:
            values += [password, unquote(password)]
    usable = {v for v in values if len(v) >= _MIN_LITERAL and v.lower() not in _TRIVIAL}
    return sorted(usable, key=len, reverse=True)  # longest first: one may contain another


def redact(text: str) -> str:
    """Strip secrets from a string or URL.

    Covers the literal value of every known secret (see _literal_secrets), and
    by shape: `name=value` and `name: value` for key/token/secret/password
    names with any prefix (query params, headers, JSON), URL-encoded
    `key%3D...`, `scheme://user:password@host`, and Authorization headers.
    """
    out = text
    for secret in _literal_secrets():
        out = out.replace(secret, REDACTED)
    out = _URL_USERINFO.sub(rf"\1:{REDACTED}@", out)
    out = _AUTH_HEADER.sub(rf"\1{REDACTED}", out)
    out = _AUTH_SCHEME.sub(rf"\1 {REDACTED}", out)
    out = _SECRET_ENCODED.sub(rf"\1{REDACTED}", out)
    out = _SECRET_ASSIGN.sub(rf"\1{REDACTED}", out)
    out = _SECRET_COLON.sub(
        lambda m: f"{m.group(1)}{m.group(2) or ''}{REDACTED}{m.group(2) or ''}", out
    )
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
