import builtins
import contextlib
import logging

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import UsageLimits

from pipeline import config
from pipeline.agents import budgets, run_log, settings, tracing


class Thing(BaseModel):
    name: str
    count: int


def lookup(query: str) -> str:
    """Look something up.

    Args:
        query: what to look up.
    """
    return f"result for {query}"


def make_agent() -> Agent[None, Thing]:
    return Agent(output_type=Thing, tools=[lookup])


# --- settings ---------------------------------------------------------------


def test_settings_defaults():
    s = settings.get_settings()
    assert s.extract_model == config.DEFAULT_EXTRACT_MODEL
    assert s.resolve_model == config.DEFAULT_RESOLVE_MODEL
    assert s.gemini_api_key is None and s.sam_api_key is None and s.logfire_token is None
    assert (s.extract_request_limit, s.resolve_tool_calls_limit, s.sam_daily_quota) == (2, 8, 10)


def test_settings_env_override_and_cache(monkeypatch):
    settings.get_settings()
    monkeypatch.setenv("EXTRACT_MODEL", "gemini-x")
    monkeypatch.setenv("resolve_tool_calls_limit", "3")
    assert settings.get_settings().extract_model == config.DEFAULT_EXTRACT_MODEL  # cached
    settings.reset_settings()
    s = settings.get_settings()
    assert s.extract_model == "gemini-x" and s.resolve_tool_calls_limit == 3


def test_blank_values_fall_back(monkeypatch):
    for name in ("GEMINI_API_KEY", "LOGFIRE_TOKEN", "EXTRACT_MODEL"):
        monkeypatch.setenv(name, "  ")
    s = settings.Settings()
    assert s.gemini_api_key is None and s.logfire_token is None
    assert s.extract_model == config.DEFAULT_EXTRACT_MODEL


def test_blank_int_settings_fall_back(monkeypatch):
    # Unset GitHub Actions variables arrive as "", which must not crash int fields.
    monkeypatch.setenv("SAM_DAILY_QUOTA", "")
    monkeypatch.setenv("RESOLVE_TOOL_CALLS_LIMIT", " ")
    s = settings.Settings()
    assert s.sam_daily_quota == 10 and s.resolve_tool_calls_limit == 8


def test_secrets_are_not_in_repr(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "sekrit-gemini")
    monkeypatch.setenv("SAM_API_KEY", "sekrit-sam")
    s = settings.Settings()
    assert "sekrit" not in repr(s) and "sekrit" not in str(s.model_dump())
    assert s.secret_values() == ["sekrit-gemini", "sekrit-sam"]


def test_settings_ignore_dotenv_in_tests(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("GEMINI_API_KEY=from-dotenv\n")
    monkeypatch.chdir(tmp_path)
    assert settings.Settings().gemini_api_key is None


def test_build_model_requires_key(monkeypatch):
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        settings.build_model("gemini-x")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    settings.reset_settings()
    model = settings.build_model("gemini-x")
    assert model.model_name == "gemini-x"
    assert settings.model_label("gemini-x") == "gemini:gemini-x"


# --- budgets ----------------------------------------------------------------


def test_budgets_defaults_and_overrides():
    assert budgets.extraction_limits().request_limit == 2
    r = budgets.resolver_limits()
    assert (r.request_limit, r.tool_calls_limit, r.total_tokens_limit) == (10, 8, 50_000)
    s = settings.Settings(resolve_tool_calls_limit=2, extract_request_limit=1)
    assert budgets.resolver_limits(s).tool_calls_limit == 2
    assert budgets.extraction_limits(s).request_limit == 1


# --- tracing ----------------------------------------------------------------


@pytest.fixture
def fresh_tracing(monkeypatch):
    monkeypatch.setattr(tracing, "_configured", False)


def test_tracing_is_a_noop_without_token(fresh_tracing, monkeypatch):
    def no_logfire(name, *a, **kw):
        assert name != "logfire", "logfire must not be imported without a token"
        return real_import(name, *a, **kw)

    real_import = builtins.__import__
    monkeypatch.setattr(builtins, "__import__", no_logfire)
    assert tracing.configure_tracing() is False


def test_tracing_survives_missing_logfire(fresh_tracing, monkeypatch, caplog):
    real_import = builtins.__import__

    def missing(name, *a, **kw):
        if name == "logfire":
            raise ImportError("No module named 'logfire'")
        return real_import(name, *a, **kw)

    monkeypatch.setattr(builtins, "__import__", missing)
    with caplog.at_level(logging.WARNING):
        assert tracing.configure_tracing(settings.Settings(logfire_token="tok")) is False
    assert "not installed" in caplog.text and "tok" not in caplog.text


def test_tracing_configures_once_with_token(fresh_tracing, monkeypatch):
    calls = []
    fake = type(
        "FakeLogfire",
        (),
        {
            "configure": staticmethod(lambda **kw: calls.append(("configure", kw))),
            "instrument_pydantic_ai": staticmethod(lambda: calls.append(("instrument", {}))),
        },
    )
    monkeypatch.setitem(__import__("sys").modules, "logfire", fake)
    s = settings.Settings(logfire_token="tok")
    assert tracing.configure_tracing(s) is True
    assert tracing.configure_tracing(s) is True  # idempotent
    assert [c[0] for c in calls] == ["configure", "instrument"]
    assert calls[0][1]["token"] == "tok"


# --- run_log ----------------------------------------------------------------


def test_redact(monkeypatch):
    monkeypatch.setenv("SAM_API_KEY", "abc123secret")
    settings.reset_settings()
    url = "https://api.sam.gov/entity-information/v4/entities?api_key=abc123secret&ueiSAM=X1"
    assert run_log.redact(url) == (
        "https://api.sam.gov/entity-information/v4/entities?api_key=REDACTED&ueiSAM=X1"
    )
    assert "abc123secret" not in run_log.redact("failed with abc123secret in body")
    assert run_log.redact("GET /x?key=zzz&q=1") == "GET /x?key=REDACTED&q=1"
    assert "tok12345678" not in run_log.redact("Authorization: Bearer tok12345678")
    assert run_log.redact_value({"u": [url], "n": 1}) == {"u": [run_log.redact(url)], "n": 1}


def test_run_logged_without_connection_just_runs():
    result = run_log.run_logged(
        make_agent(), "hi", agent_name="t", input_ref="x", model_label="test", model=TestModel()
    )
    assert isinstance(result.output, Thing) and run_log.last_run_id() is None


@pytest.mark.db
def test_run_logged_writes_ok_row(db):
    def model(messages, info):
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart("lookup", {"query": "acme?api_key=s3cr3t"})])
        return ModelResponse(
            parts=[ToolCallPart(info.output_tools[0].name, {"name": "acme", "count": 2})]
        )

    with run_log.bind(db):
        assert run_log.current_conn() is db
        result = run_log.run_logged(
            make_agent(),
            "hi",
            agent_name="thing",
            input_ref="award:1",
            model_label="gemini:test",
            model=FunctionModel(model),
        )
    assert run_log.current_conn() is None
    assert result.output == Thing(name="acme", count=2)
    row = db.execute(
        "SELECT id, agent_name, input_ref, model, status, requests, input_tokens > 0,"
        " output_tokens > 0, tool_calls, output, error, finished_at >= started_at FROM agent_runs"
    ).fetchall()
    assert row == [
        (
            run_log.last_run_id(),
            "thing",
            "award:1",
            "gemini:test",
            "ok",
            2,
            True,
            True,
            [{"tool_name": "lookup", "args": {"query": "acme?api_key=REDACTED"}}],
            {"name": "acme", "count": 2},
            None,
            True,
        )
    ]


@pytest.mark.db
def test_run_logged_records_failure_with_tool_calls_and_reraises(db):
    def loops_forever(messages, info):
        return ModelResponse(parts=[ToolCallPart("lookup", {"query": "again"})])

    db.commit()  # idle connection: the row must be committed without the caller's help
    with pytest.raises(UsageLimitExceeded):
        run_log.run_logged(
            make_agent(),
            "hi",
            agent_name="thing",
            input_ref="org:1|org:2",
            model_label="gemini:test",
            conn=db,
            model=FunctionModel(loops_forever),
            usage_limits=UsageLimits(tool_calls_limit=2),
        )
    db.rollback()
    status, requests, calls, output, error = db.execute(
        "SELECT status, requests, tool_calls, output, error FROM agent_runs"
    ).fetchone()
    assert status == "failed" and output is None
    assert error.startswith("UsageLimitExceeded:") and "tool_calls_limit" in error
    assert requests == 3 and len(calls) == 3 and calls[0]["tool_name"] == "lookup"


@pytest.mark.db
def test_failed_row_survives_when_caller_catches_inside_transaction(db):
    def boom(messages, info):
        raise RuntimeError("upstream said no: key=hunter2")

    with db.transaction(), contextlib.suppress(RuntimeError):
        run_log.run_logged(
            make_agent(),
            "hi",
            agent_name="thing",
            input_ref=None,
            model_label="gemini:test",
            conn=db,
            model=FunctionModel(boom),
        )
    assert db.execute("SELECT status, error FROM agent_runs").fetchall() == [
        ("failed", "RuntimeError: upstream said no: key=REDACTED")
    ]
