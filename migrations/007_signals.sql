-- 007_signals: computed metrics ("signals") over the award and solicitation
-- stream, for the dashboard, the leaderboards and the field report.
--
-- Two plain views define what counts (autonomy_awards, autonomy_opportunities).
-- Everything else is a materialized view built from them, refreshed together by
-- `python -m pipeline.signals` at the end of the nightly run. Each refresh
-- stamps one "as of" date (signal_meta.as_of); every window below ends on that
-- date, so all pages show the same numbers until the next refresh.
--
-- Definitions shared by every signal:
--   * Only awards and solicitations tagged with the taxonomy root ('autonomy',
--     see config/taxonomy.yaml) are counted.
--   * An award's date is signed_at, or the day we fetched it when the source
--     gave no date.
--   * A window of N days is the N days ending on as_of, inclusive. The prior
--     period is the N days before that. Windows: 7, 30, 90, 365.
--   * "slice" is the category filter: '' means all categories, otherwise one
--     tag slug. An award with two tags counts once in each of its categories
--     and once in the all-categories slice, so category figures can add up to
--     more than the total.
--   * Stage (phase_1 / phase_2 / production) is read from the award
--     description with the same patterns as pipeline.api.queries._stage_of.
--     The schema has no stage column; this is a text heuristic.

-- When a row first landed in our data. fetched_at cannot answer that: loaders
-- overwrite it every time a source re-serves the same award. The watchlist's
-- "new since your last visit" needs the first sighting. Existing rows get the
-- best date we have (their last fetch); new rows get the insert time, and no
-- loader ever updates the column.
ALTER TABLE awards ADD COLUMN first_seen_at timestamptz;
UPDATE awards SET first_seen_at = fetched_at;
ALTER TABLE awards ALTER COLUMN first_seen_at SET DEFAULT now();
ALTER TABLE awards ALTER COLUMN first_seen_at SET NOT NULL;

CREATE VIEW autonomy_awards WITH (security_invoker = true) AS
SELECT a.id, a.recipient_id, a.agency_id, a.amount, a.description, a.url, a.opportunity_id,
       a.source, a.source_id, a.fetched_at, a.first_seen_at,
       COALESCE(a.signed_at, a.fetched_at::date) AS day,
       ARRAY(
           SELECT g.slug FROM taggings t JOIN tags g ON g.id = t.tag_id
           WHERE t.entity_type = 'award' AND t.entity_id = a.id AND g.slug <> 'autonomy'
           ORDER BY g.slug
       ) AS tags,
       CASE
           WHEN a.description ~* '\yphase\s*(ii|2)\y' THEN 'phase_2'
           WHEN a.description ~* '\yphase\s*(i|1)\y' THEN 'phase_1'
           WHEN a.description ~* '\y(production|full[- ]rate|lrip|low[- ]rate initial|procure)'
               THEN 'production'
       END AS stage
FROM awards a
WHERE EXISTS (
    SELECT 1 FROM taggings t JOIN tags g ON g.id = t.tag_id
    WHERE t.entity_type = 'award' AND t.entity_id = a.id AND g.slug = 'autonomy'
);

CREATE VIEW autonomy_opportunities WITH (security_invoker = true) AS
SELECT o.id, o.title, o.agency_id, o.url, o.closes_at,
       COALESCE(o.posted_at, o.fetched_at)::date AS day,
       ARRAY(
           SELECT g.slug FROM taggings t JOIN tags g ON g.id = t.tag_id
           WHERE t.entity_type = 'opportunity' AND t.entity_id = o.id AND g.slug <> 'autonomy'
           ORDER BY g.slug
       ) AS tags
FROM opportunities o
WHERE EXISTS (
    SELECT 1 FROM taggings t JOIN tags g ON g.id = t.tag_id
    WHERE t.entity_type = 'opportunity' AND t.entity_id = o.id AND g.slug = 'autonomy'
);

-- One row: when the signals were last computed, and over how much data.
CREATE MATERIALIZED VIEW signal_meta AS
SELECT current_date AS as_of,
       now() AS refreshed_at,
       (SELECT count(*) FROM autonomy_awards) AS awards,
       (SELECT count(*) FROM autonomy_opportunities) AS opportunities,
       (SELECT min(day) FROM autonomy_awards) AS first_award_day,
       EXISTS (SELECT 1 FROM awards WHERE source = 'seed') AS sample;

-- The windows, anchored on as_of. A day is in the current period when
-- cur_after < day <= as_of, and in the prior period when
-- prev_after < day <= cur_after.
CREATE VIEW signal_windows WITH (security_invoker = true) AS
SELECT w AS window_days, m.as_of, m.as_of - w AS cur_after, m.as_of - 2 * w AS prev_after
FROM signal_meta m, unnest(ARRAY[7, 30, 90, 365]) AS w;

-- Snapshots of the two base views, so every signal reads the same rows.
CREATE MATERIALIZED VIEW signal_awards AS SELECT * FROM autonomy_awards;
CREATE UNIQUE INDEX signal_awards_id_idx ON signal_awards (id);
CREATE INDEX signal_awards_day_idx ON signal_awards (day);
CREATE INDEX signal_awards_recipient_idx ON signal_awards (recipient_id);
CREATE INDEX signal_awards_agency_idx ON signal_awards (agency_id);

CREATE MATERIALIZED VIEW signal_opportunities AS SELECT * FROM autonomy_opportunities;
CREATE UNIQUE INDEX signal_opportunities_id_idx ON signal_opportunities (id);
CREATE INDEX signal_opportunities_day_idx ON signal_opportunities (day);

-- Signals 1 and 2: funding totals and momentum.
-- One row per window, subject and slice. subject_type is 'company' (org_id is
-- the recipient), 'agency' (org_id is the awarding agency or office, as the
-- source recorded it; offices are not rolled up into their parent) or 'total'
-- (org_id is NULL: everything in the slice, so slice <> '' is one category).
--   amount / awards            dollars and award count in the current period
--   prev_amount / prev_awards  the same for the prior period
--   delta                      amount - prev_amount
--   pct                        delta / prev_amount, NULL when the prior period
--                              is under $100,000: growth from a tiny baseline
--                              is noise and stays out of percentage rankings
--   rank / prev_rank           position by dollars among the same kind of
--                              subject in the same slice (categories rank
--                              against each other), current and prior period
--   pct_rank                   position by pct, among rows that have one
CREATE MATERIALIZED VIEW signal_funding AS
WITH facts AS (
    SELECT a.recipient_id, a.agency_id, a.amount, a.day, s.slice
    FROM signal_awards a
    CROSS JOIN LATERAL (SELECT '' UNION ALL SELECT unnest(a.tags)) AS s (slice)
),
subjects AS (
    SELECT 'company' AS subject_type, recipient_id AS org_id, slice, amount, day
    FROM facts WHERE recipient_id IS NOT NULL
    UNION ALL
    SELECT 'agency', agency_id, slice, amount, day FROM facts WHERE agency_id IS NOT NULL
    UNION ALL
    SELECT 'total', NULL, slice, amount, day FROM facts
),
agg AS (
    SELECT w.window_days, s.subject_type, s.org_id, s.slice,
           COALESCE(sum(s.amount) FILTER (WHERE s.day > w.cur_after), 0) AS amount,
           count(*) FILTER (WHERE s.day > w.cur_after) AS awards,
           COALESCE(sum(s.amount) FILTER (WHERE s.day <= w.cur_after), 0) AS prev_amount,
           count(*) FILTER (WHERE s.day <= w.cur_after) AS prev_awards
    FROM subjects s
    JOIN signal_windows w ON s.day > w.prev_after AND s.day <= w.as_of
    GROUP BY w.window_days, s.subject_type, s.org_id, s.slice
),
scored AS (
    SELECT agg.*,
           amount - prev_amount AS delta,
           CASE WHEN prev_amount >= 100000 THEN (amount - prev_amount) / prev_amount END AS pct,
           -- categories ('total' rows with a slice) rank against each other
           CASE WHEN subject_type = 'total' THEN (slice = '')::text ELSE slice END AS peers
    FROM agg
)
SELECT window_days, subject_type, org_id, slice, amount, awards, prev_amount, prev_awards,
       delta, pct,
       CASE WHEN awards > 0 THEN rank() OVER (
           PARTITION BY window_days, subject_type, peers ORDER BY amount DESC
       ) END AS rank,
       CASE WHEN prev_awards > 0 THEN rank() OVER (
           PARTITION BY window_days, subject_type, peers ORDER BY prev_amount DESC
       ) END AS prev_rank,
       CASE WHEN pct IS NOT NULL THEN rank() OVER (
           PARTITION BY window_days, subject_type, peers ORDER BY pct DESC NULLS LAST
       ) END AS pct_rank
FROM scored;
CREATE UNIQUE INDEX signal_funding_key_idx
    ON signal_funding (window_days, subject_type, COALESCE(org_id, 0), slice);

-- Signal 3 (new entrants) and the entity page: one row per company with any
-- autonomy award. first_day is the first award in OUR data, which starts when
-- the sources start; it is not proof the company never won one before.
-- tags are every category the company has an award in, largest dollars first.
CREATE MATERIALIZED VIEW signal_companies AS
WITH per_tag AS (
    SELECT a.recipient_id AS org_id, t.tag, COALESCE(sum(a.amount), 0) AS amount
    FROM signal_awards a, unnest(a.tags) AS t (tag)
    WHERE a.recipient_id IS NOT NULL
    GROUP BY a.recipient_id, t.tag
),
firsts AS (
    SELECT recipient_id AS org_id, min(day) AS first_day, max(day) AS last_day,
           COALESCE(sum(amount), 0) AS amount, count(*) AS awards
    FROM signal_awards WHERE recipient_id IS NOT NULL
    GROUP BY recipient_id
)
SELECT f.org_id, f.first_day, f.last_day, f.amount, f.awards,
       (SELECT COALESCE(sum(a.amount), 0) FROM signal_awards a
        WHERE a.recipient_id = f.org_id AND a.day = f.first_day) AS first_amount,
       ARRAY(SELECT p.tag FROM per_tag p WHERE p.org_id = f.org_id
             ORDER BY p.amount DESC, p.tag) AS tags
FROM firsts f;
CREATE UNIQUE INDEX signal_companies_org_idx ON signal_companies (org_id);
CREATE INDEX signal_companies_first_idx ON signal_companies (first_day);

-- Signal 4, part one: the first day each company reached each stage.
-- 'solicitation' is the earliest posting date among solicitations one of the
-- company's awards is linked to (awards.opportunity_id). The other stages are
-- the first award whose description names that stage. first_seen_at is when
-- the earliest award that puts the company at this stage entered our data.
CREATE MATERIALIZED VIEW signal_stages AS
SELECT a.recipient_id AS org_id, 'solicitation' AS stage, 0 AS stage_order,
       min(COALESCE(o.posted_at, o.fetched_at)::date) AS day,
       0::numeric AS amount, count(DISTINCT o.id) AS n, min(a.first_seen_at) AS first_seen_at
FROM signal_awards a JOIN opportunities o ON o.id = a.opportunity_id
WHERE a.recipient_id IS NOT NULL
GROUP BY a.recipient_id
UNION ALL
SELECT a.recipient_id, a.stage,
       CASE a.stage WHEN 'phase_1' THEN 1 WHEN 'phase_2' THEN 2 ELSE 3 END,
       min(a.day), COALESCE(sum(a.amount), 0), count(*), min(a.first_seen_at)
FROM signal_awards a
WHERE a.recipient_id IS NOT NULL AND a.stage IS NOT NULL
GROUP BY a.recipient_id, a.stage;
CREATE UNIQUE INDEX signal_stages_key_idx ON signal_stages (org_id, stage);

-- Signal 4, part two: one row per company per stage reached, with the stage it
-- came from. from_stage is the furthest earlier stage the company had already
-- reached by that day; it is NULL when the company first appears in our data
-- at this stage (an entry, not a transition). days_between is the time from
-- first reaching from_stage to first reaching to_stage.
CREATE MATERIALIZED VIEW signal_transitions AS
SELECT s.org_id, p.stage AS from_stage, s.stage AS to_stage, s.stage_order,
       p.day AS from_day, s.day, s.day - p.day AS days_between, s.amount, s.n
FROM signal_stages s
LEFT JOIN LATERAL (
    SELECT q.stage, q.day FROM signal_stages q
    WHERE q.org_id = s.org_id AND q.stage_order < s.stage_order AND q.day <= s.day
    ORDER BY q.stage_order DESC LIMIT 1
) p ON true;
CREATE UNIQUE INDEX signal_transitions_key_idx ON signal_transitions (org_id, to_stage);
CREATE INDEX signal_transitions_day_idx ON signal_transitions (day);

-- Signals 5 and 7 (demand side): solicitations posted, by agency and in total.
--   posted / prev_posted  solicitations posted in the current and prior period
--   open / prev_open      solicitations open on as_of, and on the last day of
--                         the prior period (posted by then, not yet closed)
-- 'total' rows with a slice are the topic-heat rows: one per category.
CREATE MATERIALIZED VIEW signal_solicitations AS
WITH facts AS (
    SELECT o.agency_id, o.day, o.closes_at::date AS closes, s.slice
    FROM signal_opportunities o
    CROSS JOIN LATERAL (SELECT '' UNION ALL SELECT unnest(o.tags)) AS s (slice)
),
subjects AS (
    SELECT 'agency' AS subject_type, agency_id AS org_id, slice, day, closes
    FROM facts WHERE agency_id IS NOT NULL
    UNION ALL
    SELECT 'total', NULL, slice, day, closes FROM facts
)
SELECT w.window_days, s.subject_type, s.org_id, s.slice,
       count(*) FILTER (WHERE s.day > w.cur_after AND s.day <= w.as_of) AS posted,
       count(*) FILTER (WHERE s.day > w.prev_after AND s.day <= w.cur_after) AS prev_posted,
       count(*) FILTER (
           WHERE s.day <= w.as_of AND (s.closes IS NULL OR s.closes >= w.as_of)
       ) AS open,
       count(*) FILTER (
           WHERE s.day <= w.cur_after AND (s.closes IS NULL OR s.closes >= w.cur_after)
       ) AS prev_open
FROM subjects s CROSS JOIN signal_windows w
GROUP BY w.window_days, s.subject_type, s.org_id, s.slice;
CREATE UNIQUE INDEX signal_solicitations_key_idx
    ON signal_solicitations (window_days, subject_type, COALESCE(org_id, 0), slice);

-- Daily series per slice, for the charts and sparklines: dollars and awards
-- signed that day, solicitations posted that day.
CREATE MATERIALIZED VIEW signal_daily AS
WITH award_days AS (
    SELECT a.day, s.slice, COALESCE(sum(a.amount), 0) AS amount, count(*) AS awards
    FROM signal_awards a
    CROSS JOIN LATERAL (SELECT '' UNION ALL SELECT unnest(a.tags)) AS s (slice)
    GROUP BY a.day, s.slice
),
opp_days AS (
    SELECT o.day, s.slice, count(*) AS posted
    FROM signal_opportunities o
    CROSS JOIN LATERAL (SELECT '' UNION ALL SELECT unnest(o.tags)) AS s (slice)
    GROUP BY o.day, s.slice
)
SELECT COALESCE(a.day, o.day) AS day, COALESCE(a.slice, o.slice) AS slice,
       COALESCE(a.amount, 0) AS amount, COALESCE(a.awards, 0) AS awards,
       COALESCE(o.posted, 0) AS posted
FROM award_days a FULL OUTER JOIN opp_days o ON o.day = a.day AND o.slice = a.slice;
CREATE UNIQUE INDEX signal_daily_key_idx ON signal_daily (slice, day);

-- Materialized views cannot carry row-level security. Where the database is
-- served by an auto-generated API with public roles (Supabase), keep those
-- roles off the new relations; the site reads them through pipeline.api only.
DO $$
DECLARE
    role_name text;
    rel text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            FOREACH rel IN ARRAY ARRAY[
                'autonomy_awards', 'autonomy_opportunities', 'signal_windows', 'signal_meta',
                'signal_awards', 'signal_opportunities', 'signal_funding', 'signal_companies',
                'signal_stages', 'signal_transitions', 'signal_solicitations', 'signal_daily'
            ] LOOP
                EXECUTE format('REVOKE ALL ON %I FROM %I', rel, role_name);
            END LOOP;
        END IF;
    END LOOP;
END
$$;
