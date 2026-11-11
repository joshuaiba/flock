-- 004_agents_resolution: agent audit trail, HTTP cache, and entity resolution.
--
-- Applied once by the migration runner (schema_migrations); the IF NOT EXISTS
-- guards are a second line of defence so a partial manual apply can be re-run.
--
-- Pair convention: tables holding an unordered pair of organizations store it
-- as (left_org_id < right_org_id), so each pair has exactly one row.

-- A merged organization is kept, not deleted: loaders upsert on
-- (source, source_id), find the old row, and follow merged_into to the
-- canonical one. NULL = this row is canonical.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS merged_into bigint REFERENCES organizations (id);
CREATE INDEX IF NOT EXISTS organizations_merged_into_idx
    ON organizations (merged_into) WHERE merged_into IS NOT NULL;

-- One row per agent run (extraction, classifier, resolver): audit trail and
-- cost tracker, independent of any tracing backend.
CREATE TABLE IF NOT EXISTS agent_runs (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_name    text        NOT NULL,
    input_ref     text,                   -- what was processed, e.g. award:12 or org:3|org:9
    model         text        NOT NULL,   -- e.g. gemini:gemini-3.8-flash
    status        text        NOT NULL CHECK (status IN ('ok', 'failed')),
    requests      integer     NOT NULL DEFAULT 0,
    input_tokens  integer     NOT NULL DEFAULT 0,
    output_tokens integer     NOT NULL DEFAULT 0,
    tool_calls    jsonb       NOT NULL DEFAULT '[]',  -- [{tool_name, args}], secrets redacted
    output        jsonb,
    error         text,
    started_at    timestamptz NOT NULL,
    finished_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_started_idx ON agent_runs (agent_name, started_at);
CREATE INDEX IF NOT EXISTS agent_runs_failed_idx ON agent_runs (started_at) WHERE status = 'failed';

-- Responses from external lookup APIs (SAM.gov, USAspending recipient search).
-- cache_key = sha256 of method + URL + sorted params with secrets removed.
-- Rows per host per UTC day also serve as the request counter for daily quotas.
CREATE TABLE IF NOT EXISTS http_cache (
    cache_key  text        PRIMARY KEY,
    host       text        NOT NULL,
    url        text        NOT NULL,   -- no secrets
    params     jsonb       NOT NULL DEFAULT '{}',  -- no secrets
    status     integer     NOT NULL,
    body       jsonb,
    fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS http_cache_host_fetched_idx ON http_cache (host, fetched_at);

-- Applied merges. snapshot holds everything needed to undo: the merged row,
-- the canonical row's aliases before the merge, and every award/opportunity/
-- edge row that was repointed, rewritten or dropped.
CREATE TABLE IF NOT EXISTS org_merges (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_org_id bigint      NOT NULL REFERENCES organizations (id),
    merged_org_id    bigint      NOT NULL REFERENCES organizations (id),
    confidence       real        CHECK (confidence BETWEEN 0 AND 1),
    decision_source  text        NOT NULL CHECK (decision_source IN ('uei', 'agent', 'review')),
    agent_run_id     bigint REFERENCES agent_runs (id),
    snapshot         jsonb       NOT NULL,
    merged_at        timestamptz NOT NULL DEFAULT now(),
    undone_at        timestamptz,
    CHECK (canonical_org_id <> merged_org_id)
);
CREATE INDEX IF NOT EXISTS org_merges_canonical_idx ON org_merges (canonical_org_id);
CREATE INDEX IF NOT EXISTS org_merges_merged_idx ON org_merges (merged_org_id);
-- An organization can be merged away at most once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS org_merges_active_idx
    ON org_merges (merged_org_id) WHERE undone_at IS NULL;

-- Agent decisions that were not confident enough to apply; reviewed by a human.
CREATE TABLE IF NOT EXISTS pending_merges (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    left_org_id      bigint      NOT NULL REFERENCES organizations (id),
    right_org_id     bigint      NOT NULL REFERENCES organizations (id),
    decision         text        NOT NULL CHECK (decision IN ('merge', 'separate', 'unsure')),
    canonical_org_id bigint REFERENCES organizations (id),
    confidence       real        CHECK (confidence BETWEEN 0 AND 1),
    evidence         jsonb       NOT NULL DEFAULT '[]',
    reasoning        text,
    agent_run_id     bigint REFERENCES agent_runs (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    reviewed_at      timestamptz,
    reviewer_action  text        CHECK (reviewer_action IN ('accepted', 'rejected')),
    CHECK (left_org_id < right_org_id),
    CHECK ((reviewed_at IS NULL) = (reviewer_action IS NULL))
);
-- One open question per pair.
CREATE UNIQUE INDEX IF NOT EXISTS pending_merges_open_pair_idx
    ON pending_merges (left_org_id, right_org_id) WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS pending_merges_created_idx ON pending_merges (created_at);

-- Pairs known to be different organizations; never asked about again.
CREATE TABLE IF NOT EXISTS org_non_matches (
    left_org_id  bigint      NOT NULL REFERENCES organizations (id),
    right_org_id bigint      NOT NULL REFERENCES organizations (id),
    confidence   real        CHECK (confidence BETWEEN 0 AND 1),
    reasoning    text,
    agent_run_id bigint REFERENCES agent_runs (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (left_org_id, right_org_id),
    CHECK (left_org_id < right_org_id)
);
CREATE INDEX IF NOT EXISTS org_non_matches_right_idx ON org_non_matches (right_org_id);
