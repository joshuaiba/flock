"""Pricing math, usage from agent_runs, and the monthly budget guard."""

from datetime import UTC, datetime, timedelta

import pytest

from pipeline.agents import costs, run_log, settings
from pipeline.agents.costs import Price

HAIKU = "anthropic:claude-haiku-5-5"
SONNET = "anthropic:claude-sonnet-5-5"
NOW = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)


def spend(conn, agent, model, input_tokens, output_tokens, *, at=NOW, status="ok", requests=1):
    """One agent_runs row with the given usage, started at `at`."""
    run_log.record(
        conn,
        agent_name=agent,
        input_ref=None,
        model=model,
        status=status,
        requests=requests,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        tool_calls=[],
        output=None,
        error=None if status == "ok" else "boom",
        started_at=at,
        finished_at=at,
    )
    conn.commit()


# --- pricing ------------------------------------------------------------------


def test_price_list_has_the_models_in_use():
    pricing = costs.load_pricing()
    assert pricing[HAIKU] == Price(input=0.10, output=0.50)
    assert pricing[SONNET] == Price(input=2.00, output=10.00)
    assert "gemini:gemini-3.8-flash" in pricing
    # The default models are priced, or the budget guard would count them as free.
    s = settings.get_settings()
    for name in (s.extract_model, s.resolve_model):
        assert settings.model_label(name) in pricing


@pytest.mark.parametrize(
    "model, tokens_in, tokens_out, expected",
    [
        (HAIKU, 1_000_000, 0, 0.10),
        (HAIKU, 0, 1_000_000, 0.50),
        (HAIKU, 15_500, 1_300, 0.0022),  # one resolver decision as measured in the README
        (SONNET, 1_000_000, 1_000_000, 12.00),
        (SONNET, 250_000, 40_000, 0.90),
        (HAIKU, 0, 0, 0.0),
    ],
)
def test_cost_math(model, tokens_in, tokens_out, expected):
    assert costs.cost_usd(model, tokens_in, tokens_out) == pytest.approx(expected)


def test_cost_of_an_unpriced_model_is_unknown_not_zero():
    assert costs.cost_usd("fake:test", 1_000_000, 1_000_000) is None
    custom = {"fake:test": Price(input=3.0, output=6.0)}
    assert costs.cost_usd("fake:test", 500_000, 500_000, custom) == pytest.approx(4.5)
    assert costs.cost_usd(HAIKU, 1, 1, custom) is None


def test_month_start_is_utc():
    assert costs.month_start(NOW) == datetime(2026, 11, 1, tzinfo=UTC)
    # 31 Oct 20:00 in New York is already November in UTC.
    new_york = datetime(2026, 10, 31, 20, 0, tzinfo=UTC) + timedelta(hours=4)
    assert costs.month_start(new_york) == datetime(2026, 11, 1, tzinfo=UTC)
    assert costs.month_start(datetime(2026, 1, 1, 0, 0, tzinfo=UTC)).month == 1


# --- usage from agent_runs ------------------------------------------------------


@pytest.mark.db
def test_usage_by_agent_sums_tokens_and_prices_each_model(db):
    spend(db, "classifier", HAIKU, 1_000_000, 100_000)
    spend(db, "classifier", HAIKU, 1_000_000, 100_000, status="failed")  # spent all the same
    spend(db, "classifier", "gemini:gemini-3.8-flash", 5_000_000, 5_000_000)  # priced at $0
    spend(db, "resolver", SONNET, 100_000, 10_000, requests=4)
    spend(db, "resolver", "fake:test", 7, 3)  # no price
    spend(db, "resolver", HAIKU, 9_000_000, 0, at=NOW - timedelta(days=40))  # another month

    usage = costs.usage_by_agent(db, costs.month_start(NOW))
    assert [a["agent"] for a in usage] == ["classifier", "resolver"]
    classifier, resolver = usage
    assert (classifier["runs"], classifier["input_tokens"], classifier["output_tokens"]) == (
        3,
        7_000_000,
        5_200_000,
    )
    assert classifier["cost_usd"] == pytest.approx(2 * (0.10 + 0.05)) and not classifier["unpriced"]
    assert (resolver["runs"], resolver["requests"], resolver["input_tokens"]) == (2, 5, 100_007)
    assert resolver["cost_usd"] == pytest.approx(0.20 + 0.10)
    assert resolver["unpriced"] == ["fake:test"]
    assert costs.total_usd(usage) == pytest.approx(0.60)
    assert costs.month_to_date_usd(db, NOW) == pytest.approx(0.60)

    # A window: only what started in [since, until).
    earlier = costs.usage_by_agent(db, NOW - timedelta(days=60), until=NOW - timedelta(days=30))
    assert [(a["agent"], a["cost_usd"]) for a in earlier] == [("resolver", pytest.approx(0.90))]
    assert costs.usage_by_agent(db, NOW + timedelta(seconds=1)) == []


# --- the budget guard -----------------------------------------------------------


@pytest.mark.db
def test_over_budget_only_once_the_months_spend_reaches_the_budget(db, caplog):
    s = settings.Settings(monthly_llm_budget_usd=1.00)
    assert costs.over_budget(db, s, NOW) is None  # nothing spent
    spend(db, "classifier", SONNET, 300_000, 0)  # $0.60
    spend(db, "resolver", SONNET, 5_000_000, 0, at=NOW - timedelta(days=40))  # last month: $10
    spend(db, "resolver", "fake:test", 10**9, 10**9)  # unpriced: cannot count
    assert costs.over_budget(db, s, NOW) is None
    assert caplog.text == ""

    spend(db, "resolver", SONNET, 0, 40_000)  # +$0.40 -> exactly the budget
    with caplog.at_level("WARNING"):
        reason = costs.over_budget(db, s, NOW)
    assert reason.startswith("monthly LLM budget reached: an estimated $1.00 spent since")
    assert "2026-11-01" in reason and "budget $1.00" in reason
    assert "skipping this pass" in caplog.text
    # A bigger budget, or a new month, and passes run again.
    assert costs.over_budget(db, settings.Settings(monthly_llm_budget_usd=1.01), NOW) is None
    assert costs.over_budget(db, s, datetime(2026, 12, 1, 0, 0, 1, tzinfo=UTC)) is None


@pytest.mark.db
def test_budget_comes_from_settings_and_defaults_to_90(db, monkeypatch):
    spend(db, "classifier", SONNET, 44_000_000, 0, at=datetime.now(UTC))  # $88
    assert costs.over_budget(db) is None
    spend(db, "classifier", SONNET, 1_000_000, 0, at=datetime.now(UTC))  # $90
    assert "budget $90.00" in costs.over_budget(db)
    monkeypatch.setenv("MONTHLY_LLM_BUDGET_USD", "250")
    settings.reset_settings()
    assert costs.over_budget(db) is None
