# flock

A pipeline and knowledge graph tracking US defense funding for autonomy and
drones. It covers both sides of the market:

- **Demand**: solicitations, BAAs, and topics (`opportunities`)
- **Supply**: obligated contract awards (`awards`)

Both link to `organizations` (companies, agencies, offices). An LLM classifier
tags them with an autonomy taxonomy, and they're connected through typed
`edges`.

## Architecture

```mermaid
flowchart LR
    subgraph sources["pipeline/sources/&lt;name&gt;"]
        F[fetch.py] --> R[(data/raw/&lt;source&gt;/YYYY-MM-DD.jsonl<br/>immutable snapshots)]
        R --> N[normalize.py]
    end
    N --> X["pipeline/extract<br/>llm.extract(text, schema)<br/>autonomy classifier"]
    N --> RS["pipeline/resolve<br/>entity resolution (stub)"]
    X --> L["pipeline/load<br/>idempotent upserts"]
    RS --> L
    L --> PG[(Postgres)]

    subgraph PG_tables[" "]
        direction TB
        O[organizations] --- A[awards]
        O --- OP[opportunities]
        A --- T[taggings → tags]
        OP --- T
        E[edges]
    end
    PG -.-> PG_tables
```

Every source works the same way:

1. **fetch** pulls from the upstream API politely (descriptive User-Agent,
   backoff on 429/5xx, one request at a time per host) and writes an
   append-only raw snapshot to `data/raw/<source>/<YYYY-MM-DD>.jsonl`.
2. **normalize** turns raw records into Pydantic models that mirror the
   schema. It's a pure function, so it's testable against recorded fixtures.
3. **load** upserts into Postgres with `ON CONFLICT (source, source_id)`.
   Re-running a load is a no-op.

Every row carries `source`, `source_id`, and `fetched_at` for provenance.

## Sources

| Source | What | Notes |
| --- | --- | --- |
| `usaspending` | DoD contract awards matching `config/keywords.yaml` | No key. DoD data is published ~90 days after signing, so we look back 180 days nightly and let idempotent upserts pick up late records. |
| `dod_contracts` | Daily DoD contract announcements (≥ $7.5M), split into paragraphs and extracted with `llm.extract` | New days are found via the war.gov RSS feed. Article pages return 403 (Akamai) to non-browser clients, so pages come from (1) a polite direct fetch, (2) Bright Data Web Unlocker **only if** `BRIGHTDATA_API_KEY` + `BRIGHTDATA_ZONE` are set, or (3) HTML saved from a browser into `data/inbox/dod_contracts/`. The raw paragraph is stored next to its extraction (`awards.raw_text`, `awards.extraction`). |

### Fetching policy

All fetches go through `pipeline.http.PoliteClient`: a descriptive
User-Agent, one request at a time per host, and backoff on 429/5xx. The one
deliberate exception is the opt-in Bright Data fallback for war.gov article
pages. It goes around DoD's bot protection, so it stays off unless an
operator sets both secrets. Volume is about one page per weekday.

## Layout

```
pipeline/
  sources/<name>/{fetch.py, normalize.py}   one folder per source
  extract/                                  LLM extraction + autonomy classifier
  resolve/                                  entity resolution (stub)
  load/                                     Postgres upserts
  db.py                                     connection + migration runner
data/raw/<source>/<YYYY-MM-DD>.jsonl        immutable raw snapshots
migrations/                                 plain SQL, applied in order
config/                                     keyword lists, taxonomy
tests/                                      unit tests on recorded fixtures
.github/workflows/                          scheduled runs
```

## Setup

```sh
uv sync
cp .env.example .env    # then fill in DATABASE_URL, GEMINI_API_KEY
uv run python -m pipeline.db    # apply migrations
```

## Development

```sh
uv run ruff check . && uv run ruff format --check .
uv run pytest
```

Database tests run against a throwaway embedded Postgres (`pgserver`, a dev
dependency), or against `TEST_DATABASE_URL` if you set it. They never read
`DATABASE_URL`. Tests never make live network calls; ingestors are tested
against recorded fixtures in `tests/fixtures/`.

## Scheduled runs

`.github/workflows/nightly.yml` runs daily at 09:00 UTC (and on manual
dispatch): migrate → USAspending → DoD announcements → classifier. It writes
a job summary with new-row counts per step and table totals, and uploads
`data/raw/` as a 90-day artifact. USAspending and the classifier are
required. The DoD step is non-blocking because its pages are usually 403.

Repository **secrets**:

| Secret | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `GEMINI_API_KEY` | yes | `llm.extract` (DoD extraction + classifier) |
| `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ZONE` | no | Opt-in unlocker for war.gov article pages |

Optional repository **variables**: `FLOCK_CONTACT` (appended to the
User-Agent) and `EXTRACT_MODEL`.

`.github/workflows/ci.yml` runs ruff and pytest against a Postgres service
container on every push and PR.
