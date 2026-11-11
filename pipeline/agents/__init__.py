"""Shared infrastructure for the Pydantic AI agents (settings, budgets, tracing, run log).

Agents are used in two places only: single-shot extraction/classification
(pipeline/extract) and entity resolution (pipeline/resolve). Ingestion and
normalization stay plain Python.
"""

import os

# Pydantic AI prints a promotional banner on the first run of a process; keep
# pipeline output (JSON stats lines, job summary) clean.
os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")
