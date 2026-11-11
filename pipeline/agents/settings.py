"""Environment-driven settings for the agents: models, API keys, budgets.

Values come from the process environment, then from a local `.env` file.
Secrets are `SecretStr`, so they never appear in reprs or logs by accident.
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from pipeline import config

if TYPE_CHECKING:
    from pydantic_ai.models.google import GoogleModel

SECRET_FIELDS = ("gemini_api_key", "sam_api_key", "logfire_token")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # API keys (all optional at import time; each consumer checks what it needs).
    gemini_api_key: SecretStr | None = None
    sam_api_key: SecretStr | None = None
    logfire_token: SecretStr | None = None

    # Bare Gemini model names, e.g. "gemini-3.8-flash".
    extract_model: str = config.DEFAULT_EXTRACT_MODEL
    resolve_model: str = config.DEFAULT_RESOLVE_MODEL

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
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator(
        "extract_model",
        "resolve_model",
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


def model_label(name: str) -> str:
    """Label stored with results (awards.extraction_model, classifications.model, agent_runs)."""
    return f"gemini:{name}"


def build_model(name: str, settings: Settings | None = None) -> GoogleModel:
    """A Pydantic AI Gemini model for `name`, authenticated with GEMINI_API_KEY."""
    from pydantic_ai.models.google import GoogleModel
    from pydantic_ai.providers.google import GoogleProvider

    settings = settings or get_settings()
    if settings.gemini_api_key is None:
        raise RuntimeError("GEMINI_API_KEY is not set")
    provider = GoogleProvider(api_key=settings.gemini_api_key.get_secret_value())
    return GoogleModel(name, provider=provider)
