from __future__ import annotations

from pathlib import Path

import yaml

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"

# Default models, as "<provider>:<model>" (a bare name means Gemini; see
# pipeline.agents.settings.parse_model). Override with the EXTRACT_MODEL /
# RESOLVE_MODEL env vars; agent modules never hardcode a model.
DEFAULT_EXTRACT_MODEL = "anthropic:claude-haiku-5-5"
DEFAULT_RESOLVE_MODEL = "anthropic:claude-haiku-5-5"


def load_yaml(name: str) -> dict:
    return yaml.safe_load((CONFIG_DIR / name).read_text())


def keywords(source: str) -> list[str]:
    return list(load_yaml("keywords.yaml")[source])
