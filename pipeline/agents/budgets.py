"""Per-agent usage budgets. The only place UsageLimits are defined.

A run that would exceed its budget raises pydantic_ai.exceptions.UsageLimitExceeded;
run_log records it as a failed run and callers treat it as "no result".
"""

from __future__ import annotations

from pydantic_ai.usage import UsageLimits

from pipeline.agents.settings import Settings, get_settings


def extraction_limits(settings: Settings | None = None) -> UsageLimits:
    """Single-shot extraction/classification: the first attempt plus one correction."""
    s = settings or get_settings()
    return UsageLimits(request_limit=s.extract_request_limit)


def resolver_limits(settings: Settings | None = None) -> UsageLimits:
    """Entity resolution: a handful of read-only lookups, then a decision."""
    s = settings or get_settings()
    return UsageLimits(
        request_limit=s.resolve_request_limit,
        tool_calls_limit=s.resolve_tool_calls_limit,
        total_tokens_limit=s.resolve_total_tokens_limit,
    )
