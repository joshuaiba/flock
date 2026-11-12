"""Estimated LLM spend, from `agent_runs` and config/pricing.yaml.

    costs.cost_usd("anthropic:claude-haiku-5-5", 1_000_000, 0)   # 0.10
    costs.usage_by_agent(conn, since)   # tokens and dollars per agent
    costs.over_budget(conn)             # a message once the month's budget is spent

An estimate, not a bill. Every input token is priced at the model's plain
input rate. With prompt caching (Claude), tokens read from the cache cost a
tenth of that and tokens written to it a quarter more, and agent_runs does not
record the split, so the figure runs somewhat high while the cache is hitting.
For a budget guard that is the safe direction.

The month is the UTC calendar month, which is also when Anthropic's own
monthly limits reset.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache

import psycopg

from pipeline import config
from pipeline.agents.settings import Settings, get_settings

log = logging.getLogger(__name__)

PRICING_FILE = "pricing.yaml"
PER_MILLION = 1_000_000


@dataclass(frozen=True)
class Price:
    """USD per million tokens."""

    input: float
    output: float


@lru_cache(maxsize=1)
def load_pricing() -> dict[str, Price]:
    """config/pricing.yaml as {model label: Price}."""
    models = config.load_yaml(PRICING_FILE).get("models") or {}
    return {
        label: Price(input=float(p["input"]), output=float(p["output"]))
        for label, p in models.items()
    }


def cost_usd(
    model: str, input_tokens: int, output_tokens: int, pricing: dict[str, Price] | None = None
) -> float | None:
    """Estimated dollars for these tokens on `model` (an agent_runs.model label).

    None when the model has no entry in the price list.
    """
    price = (load_pricing() if pricing is None else pricing).get(model)
    if price is None:
        return None
    return (input_tokens * price.input + output_tokens * price.output) / PER_MILLION


def month_start(now: datetime | None = None) -> datetime:
    """00:00 UTC on the first day of `now`'s month."""
    now = (now or datetime.now(UTC)).astimezone(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def usage_by_agent(
    conn: psycopg.Connection,
    since: datetime,
    until: datetime | None = None,
    pricing: dict[str, Price] | None = None,
) -> list[dict]:
    """Usage and estimated cost per agent, for runs started in [since, until).

    One JSON-serializable dict per agent_name, sorted by name:
    {agent, runs, requests, input_tokens, output_tokens, cost_usd, unpriced}.
    Failed runs count: their tokens were spent too. `unpriced` lists the
    models used that have no price (their tokens are in the totals at $0).
    """
    rows = conn.execute(
        """SELECT agent_name, model, count(*), coalesce(sum(requests), 0),
                  coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
           FROM agent_runs
           WHERE started_at >= %(since)s
             AND (%(until)s::timestamptz IS NULL OR started_at < %(until)s)
           GROUP BY 1, 2
           ORDER BY 1, 2""",
        {"since": since, "until": until},
    ).fetchall()
    agents: dict[str, dict] = {}
    for agent, model, runs, requests, input_tokens, output_tokens in rows:
        a = agents.setdefault(
            agent,
            {
                "agent": agent,
                "runs": 0,
                "requests": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": 0.0,
                "unpriced": [],
            },
        )
        a["runs"] += int(runs)
        a["requests"] += int(requests)
        a["input_tokens"] += int(input_tokens)
        a["output_tokens"] += int(output_tokens)
        cost = cost_usd(model, int(input_tokens), int(output_tokens), pricing)
        if cost is None:
            a["unpriced"].append(model)
        else:
            a["cost_usd"] += cost
    return list(agents.values())


def total_usd(usage: list[dict]) -> float:
    return sum(a["cost_usd"] for a in usage)


def month_to_date_usd(
    conn: psycopg.Connection,
    now: datetime | None = None,
    pricing: dict[str, Price] | None = None,
) -> float:
    """Estimated spend across all agents since the start of the UTC month."""
    return total_usd(usage_by_agent(conn, month_start(now), pricing=pricing))


def over_budget(
    conn: psycopg.Connection,
    settings: Settings | None = None,
    now: datetime | None = None,
    pricing: dict[str, Price] | None = None,
) -> str | None:
    """The budget guard, asked before an LLM pass starts.

    None while estimated month-to-date spend is under MONTHLY_LLM_BUDGET_USD.
    Once it is reached, returns the reason (also logged) and the caller skips
    its pass: no error, exit 0, and the reason goes into the step's stats as
    `over_budget` for the job summary.

    This is a SELECT, so on a connection that is not in autocommit mode it
    leaves a read transaction open; callers commit right after.
    """
    budget = (settings or get_settings()).monthly_llm_budget_usd
    start = month_start(now)
    spent = total_usd(usage_by_agent(conn, start, pricing=pricing))
    if spent < budget:
        return None
    reason = (
        f"monthly LLM budget reached: an estimated ${spent:,.2f} spent since "
        f"{start:%Y-%m-%d} UTC, budget ${budget:,.2f} (MONTHLY_LLM_BUDGET_USD)"
    )
    log.warning("%s; skipping this pass", reason)
    return reason
