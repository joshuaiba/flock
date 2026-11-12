"""Environment-driven settings for the agents: models, API keys, budgets.

Values come from the process environment, then from a local `.env` file.
Secrets are `SecretStr`, so they never appear in reprs or logs by accident.

Model names carry a provider prefix: "anthropic:claude-haiku-5-5" or
"gemini:gemini-3.8-flash". A bare name ("gemini-3.8-flash") means Gemini, which
is what every config written before Claude support looks like.
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from pipeline import config

if TYPE_CHECKING:
    from pydantic_ai.models import Model

SECRET_FIELDS = ("anthropic_api_key", "gemini_api_key", "sam_api_key", "logfire_token")

# Provider prefix -> the environment variable holding its API key.
PROVIDER_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}
DEFAULT_PROVIDER = "gemini"  # what a name without a prefix means


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # API keys (all optional at import time; each consumer checks what it needs).
    anthropic_api_key: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    sam_api_key: SecretStr | None = None
    logfire_token: SecretStr | None = None

    # "<provider>:<model>", e.g. "anthropic:claude-haiku-5-5" (see parse_model).
    extract_model: str = config.DEFAULT_EXTRACT_MODEL
    resolve_model: str = config.DEFAULT_RESOLVE_MODEL

    # Seconds between LLM calls (pipeline.extract.llm.Provider paces itself).
    llm_min_interval: float = Field(default=1.0, ge=0)
    # Estimated month-to-date spend at which LLM passes stop (pipeline.agents.costs).
    monthly_llm_budget_usd: float = Field(default=90.0, ge=0)

    # Budgets (see budgets.py, the only place these become UsageLimits).
    extract_request_limit: int = 2
    resolve_request_limit: int = 10
    resolve_tool_calls_limit: int = 8
    resolve_total_tokens_limit: int = 50_000

    # SAM.gov documents no quota error, so we count requests ourselves.
    sam_daily_quota: int = 10

    @field_validator(*SECRET_FIELDS, mode="before")
    @classmethod
    def _blank_secret_is_none(cls, v):
        # Stripped: a key pasted with a trailing newline is an illegal header value.
        return (v.strip() or None) if isinstance(v, str) else v

    @field_validator(
        "extract_model",
        "resolve_model",
        "llm_min_interval",
        "monthly_llm_budget_usd",
        "extract_request_limit",
        "resolve_request_limit",
        "resolve_tool_calls_limit",
        "resolve_total_tokens_limit",
        "sam_daily_quota",
        mode="before",
    )
    @classmethod
    def _blank_is_default(cls, v, info):
        # GitHub Actions passes unset repo variables as empty strings.
        if isinstance(v, str) and not v.strip():
            return cls.model_fields[info.field_name].default
        return v

    def secret_values(self) -> list[str]:
        """Plain values of every configured secret, for redaction."""
        out = []
        for name in SECRET_FIELDS:
            value = getattr(self, name)
            if value is not None:
                out.append(value.get_secret_value())
        return out


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings() -> None:
    """Drop the cached Settings so the next get_settings() re-reads the environment."""
    get_settings.cache_clear()


def parse_model(name: str) -> tuple[str, str]:
    """Split a configured model name into (provider, model).

    "anthropic:claude-haiku-5-5" -> ("anthropic", "claude-haiku-5-5"). A name
    without a prefix is a Gemini model: "gemini-3.8-flash" -> ("gemini", ...).
    """
    prefix, sep, model = name.strip().partition(":")
    if not sep:
        prefix, model = DEFAULT_PROVIDER, prefix
    provider, model = prefix.strip().lower(), model.strip()
    if provider not in PROVIDER_KEYS:
        known = ", ".join(sorted(PROVIDER_KEYS))
        raise ValueError(f"unknown model provider {prefix!r} in {name!r}; use one of: {known}")
    if not model:
        raise ValueError(f"no model name in {name!r}")
    return provider, model


def model_label(name: str) -> str:
    """Label stored with results (awards.extraction_model, classifications.model, agent_runs).

    Always "<provider>:<model>", so a bare "gemini-3.8-flash" and
    "gemini:gemini-3.8-flash" give the same label.
    """
    provider, model = parse_model(name)
    return f"{provider}:{model}"


def build_model(name: str, settings: Settings | None = None) -> Model:
    """The Pydantic AI model for `name`, authenticated with its provider's API key."""
    provider, model = parse_model(name)
    settings = settings or get_settings()
    key: SecretStr | None = getattr(settings, f"{provider}_api_key")
    if key is None:
        raise RuntimeError(
            f"{PROVIDER_KEYS[provider]} is not set (needed for model {model_label(name)!r})"
        )
    if provider == "anthropic":
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        return AnthropicModel(model, provider=AnthropicProvider(api_key=key.get_secret_value()))
    from pydantic_ai.models.google import GoogleModel
    from pydantic_ai.providers.google import GoogleProvider

    return GoogleModel(model, provider=GoogleProvider(api_key=key.get_secret_value()))
