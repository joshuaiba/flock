"""Run the real resolver agent over tests/evals/resolve/pairs.yaml and score it.

    uv run --env-file .env python scripts/eval_resolver.py [--path FILE] [--limit N] [--json]

Manual only: live LLM and HTTP calls. Needs DATABASE_URL and GEMINI_API_KEY.
The logic lives in pipeline/resolve/evals.py.
"""

import sys

from pipeline.resolve.evals import main

if __name__ == "__main__":
    sys.exit(main())
