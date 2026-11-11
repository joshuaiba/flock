# Resolver eval

`pairs.yaml` holds hand-labeled organization pairs:
`{id, left {name, uei}, right {name, uei}, expected, expected_canonical, note}`.

- It currently holds **5 placeholders**, each marked `todo: true`. They cover
  the classes that matter (spelling variant, division name, parent vs
  subsidiary, joint venture vs partner, rename after an acquisition) but were
  written from general knowledge, not verified. Their UEIs are null on
  purpose: a made-up UEI would send the agent to the wrong SAM.gov record.
- Replace them with about 20 real pairs from the `organizations` table and
  remove `todo: true` from each one you have checked. `pending_merges` and
  `org_non_matches` are good sources of hard cases.
- "merge" means the same legal entity. Parent vs subsidiary and joint venture
  vs partner are "separate".

Run it (live LLM and HTTP calls; needs DATABASE_URL and GEMINI_API_KEY, plus
SAM_API_KEY if you want SAM.gov lookups):

    uv run --env-file .env python scripts/eval_resolver.py [--limit N] [--json]

It reports accuracy, precision and recall on "merge", how often the canonical
side was right, and average requests, tool calls and tokens per decision, then
lists every miss with the agent's reasoning. It is manual only and never runs
in CI. CI only checks that the YAML is valid and that the scoring is right.

What it writes to the database:

- Each pair's two organizations are inserted as temporary rows, the agent
  runs, and the rows are deleted again in the same transaction, so nothing
  else ever sees them. The eval only calls the agent's `decide`. It never
  applies a decision, so it cannot merge anything.
- `http_cache` and `http_requests` rows are kept. That keeps the SAM.gov daily quota count honest
  and makes a second eval run cheap.
- `agent_runs` rows are kept too, under `agent_name = 'resolver'`, so eval
  spend shows up in the cost audit. Their `input_ref` points at the deleted
  temporary organization ids.

Five pairs is a smoke test, not a benchmark.
