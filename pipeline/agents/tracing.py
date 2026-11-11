"""Optional Logfire tracing. A no-op unless LOGFIRE_TOKEN is set.

The pipeline must run without Logfire: the `agent_runs` table (run_log.py) is
the audit trail either way. Install the extra with
`uv sync --group observability`.
"""

from __future__ import annotations

import logging

from pipeline.agents.settings import Settings, get_settings

log = logging.getLogger(__name__)

_configured = False


def configure_tracing(settings: Settings | None = None) -> bool:
    """Configure Logfire and instrument Pydantic AI. Returns True if tracing is on."""
    global _configured
    if _configured:
        return True
    s = settings or get_settings()
    if s.logfire_token is None:
        return False
    try:
        import logfire
    except ImportError:
        log.warning(
            "LOGFIRE_TOKEN is set but logfire is not installed "
            "(uv sync --group observability); continuing without tracing"
        )
        return False
    try:
        logfire.configure(
            token=s.logfire_token.get_secret_value(),
            service_name="flock",
            console=False,  # stdout carries JSON stats lines
        )
        logfire.instrument_pydantic_ai()
    except Exception as e:  # tracing must never break the pipeline
        log.warning("could not configure Logfire (%s); continuing without tracing", e)
        return False
    _configured = True
    log.info("Logfire tracing enabled")
    return True
