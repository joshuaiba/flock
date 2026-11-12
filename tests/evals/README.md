# Autonomy classifier eval

`autonomy.jsonl` holds 20 hand-labeled examples: `{id, text, is_autonomy, tags}`.

- 13 positives and 7 negatives, with real text from USAspending (2026-11-09
  snapshot) and a recorded DoD contract announcement page.
- The negatives are deliberately hard. They're real keyword false positives:
  urinalysis "UA" supplies and "UAC" (unauthorized commitment) ratifications
  that matched the `UAS` keyword, a satellite program named "SWARM", and a
  laptop order filed under the "UNMANNED AIRCRAFT" PSC code. There are also
  two long-form announcement paragraphs with no autonomy content.
- `id` is `<source>:<source_id>`, so you can trace each example back to its origin.

Run it (live LLM calls; needs the API key of the model's provider):

    uv run --env-file .env python -m pipeline.extract.eval_classifier
    uv run --env-file .env python -m pipeline.extract.eval_classifier --model gemini:gemini-3.8-flash

Without `--model` it uses `EXTRACT_MODEL`. It also prints the tokens used and
their estimated cost at the prices in `config/pricing.yaml`.

It reports precision/recall/F1 for `is_autonomy`, micro-averaged and per-tag
P/R over tags, and lists every miss. Twenty examples is a smoke test, not a
benchmark. Grow the set whenever a misclassification turns up in production
data.
