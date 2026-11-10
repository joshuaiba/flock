-- 001_init: core entities for the flock knowledge graph.
--
-- Provenance convention: every table carries (source, source_id, fetched_at).
-- Loaders upsert with ON CONFLICT (source, source_id), so re-running a load is
-- idempotent. For derived rows (tags, taggings, edges) source_id is a
-- deterministic key built from the row's natural key.

CREATE TABLE organizations (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_name text        NOT NULL,
    uei            text,
    aliases        text[]      NOT NULL DEFAULT '{}',
    kind           text        NOT NULL CHECK (kind IN ('company', 'agency', 'office')),
    source         text        NOT NULL,
    source_id      text        NOT NULL,
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
-- Not unique: until entity resolution exists, the same UEI can appear under
-- several sources.
CREATE INDEX organizations_uei_idx ON organizations (uei) WHERE uei IS NOT NULL;

-- Demand side: solicitations, RFIs, BAAs, topics.
CREATE TABLE opportunities (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       text        NOT NULL,
    description text,
    agency_id   bigint REFERENCES organizations (id),
    posted_at   timestamptz,
    closes_at   timestamptz,
    url         text,
    source      text        NOT NULL,
    source_id   text        NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX opportunities_agency_idx ON opportunities (agency_id);

-- Supply side: obligated money.
CREATE TABLE awards (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_id   bigint REFERENCES organizations (id),
    agency_id      bigint REFERENCES organizations (id),
    amount         numeric(18, 2),
    signed_at      date,
    description    text,
    opportunity_id bigint REFERENCES opportunities (id),
    url            text,
    source         text        NOT NULL,
    source_id      text        NOT NULL,
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX awards_recipient_idx ON awards (recipient_id);
CREATE INDEX awards_agency_idx ON awards (agency_id);
CREATE INDEX awards_signed_at_idx ON awards (signed_at);

-- Autonomy taxonomy (swarming, counter-uas, gps-denied-nav, maritime, ...).
CREATE TABLE tags (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug        text        NOT NULL UNIQUE,
    description text,
    source      text        NOT NULL,
    source_id   text        NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);

CREATE TABLE taggings (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type text        NOT NULL CHECK (entity_type IN ('award', 'opportunity', 'organization')),
    entity_id   bigint      NOT NULL,
    tag_id      bigint      NOT NULL REFERENCES tags (id),
    confidence  real        CHECK (confidence BETWEEN 0 AND 1),
    source      text        NOT NULL,
    source_id   text        NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX taggings_entity_idx ON taggings (entity_type, entity_id);
CREATE INDEX taggings_tag_idx ON taggings (tag_id);

-- Generic typed relations for the graph, e.g.
--   award -awarded_to-> organization, opportunity -resulted_in-> award.
CREATE TABLE edges (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    src_type     text        NOT NULL,
    src_id       bigint      NOT NULL,
    rel          text        NOT NULL,
    dst_type     text        NOT NULL,
    dst_id       bigint      NOT NULL,
    evidence_url text,
    confidence   real        CHECK (confidence BETWEEN 0 AND 1),
    source       text        NOT NULL,
    source_id    text        NOT NULL,
    fetched_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX edges_src_idx ON edges (src_type, src_id);
CREATE INDEX edges_dst_idx ON edges (dst_type, dst_id);
