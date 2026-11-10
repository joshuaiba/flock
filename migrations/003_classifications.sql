-- 003_classifications: one autonomy-classifier verdict per entity per
-- classifier version, including negatives (so they aren't re-classified every
-- night). Tags from positive verdicts are written to taggings.

CREATE TABLE classifications (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type text        NOT NULL CHECK (entity_type IN ('award', 'opportunity', 'organization')),
    entity_id   bigint      NOT NULL,
    is_autonomy boolean     NOT NULL,
    tags        text[]      NOT NULL DEFAULT '{}',
    confidence  real        CHECK (confidence BETWEEN 0 AND 1),
    rationale   text,
    model       text        NOT NULL,
    text_hash   text        NOT NULL,  -- md5 of the classified text; re-classify when it changes
    source      text        NOT NULL,  -- classifier:<version>
    source_id   text        NOT NULL,  -- <entity_type>:<entity_id>
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX classifications_entity_idx ON classifications (entity_type, entity_id);
CREATE INDEX classifications_positive_idx ON classifications (entity_type) WHERE is_autonomy;
