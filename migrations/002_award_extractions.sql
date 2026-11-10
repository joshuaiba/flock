-- 002_award_extractions: keep source text next to LLM output.
--
-- For sources whose awards are extracted from prose (e.g. DoD daily contract
-- announcements), raw_text is the exact paragraph the extraction was produced
-- from, extraction is the validated structured output, and extraction_model
-- identifies the provider/model that produced it.

ALTER TABLE awards
    ADD COLUMN raw_text         text,
    ADD COLUMN extraction       jsonb,
    ADD COLUMN extraction_model text;
