-- 008_signals_data_anchor: the signal windows end on the record's newest
-- award, not on the calendar's today.
--
-- 007 stamped signal_meta.as_of = current_date, and every window (7, 30, 90,
-- 365 days) ended there. The record lags the calendar: USAspending publishes
-- DoD contracts about 90 days after signing, so on any given day "the last 30
-- days" and often "the last 90 days" hold no awards at all, and the dashboard,
-- the field report and the hero's 30-day figures read zero.
--
-- From here on as_of is the day of the newest autonomy award in the snapshot
-- (signal_awards), the same rule the graph's "Recent" window follows
-- (pipeline.api.queries.graph, recent=True). Two edges:
--   * No autonomy awards at all: as_of falls back to current_date, so the
--     views still have a date and every window is simply empty.
--   * An award dated after today (a source's typo, or a clock): it does not
--     move the anchor. One bad date would otherwise drag every window into the
--     future and empty it. Such an award sits after as_of, so no window counts
--     it until the calendar reaches its date.
-- Solicitation windows end on the same day, so every figure on a page still
-- covers the same days: "open" means open on as_of, and a solicitation posted
-- after the newest award is not counted until an award that recent arrives.
--
-- The window arithmetic is unchanged: a day is in the current period when
-- cur_after < day <= as_of, and in the prior period when
-- prev_after < day <= cur_after.
--
-- signal_meta now reads the two snapshots instead of the live tables, so as_of
-- and the counts always describe exactly the rows the other signals were built
-- from. That changes the refresh order (pipeline/signals.py): the snapshots
-- first, then signal_meta, then the rest.

-- signal_meta is a materialized view, so it has to be dropped to be redefined,
-- and signal_windows depends on it (signal_funding and signal_solicitations
-- depend on signal_windows in turn). Point signal_windows away from signal_meta
-- for a moment, with the same columns and types, so that nothing but
-- signal_meta itself has to be dropped. The real definition is restored below,
-- inside the same transaction.
CREATE OR REPLACE VIEW signal_windows WITH (security_invoker = true) AS
SELECT w AS window_days, NULL::date AS as_of, NULL::date AS cur_after, NULL::date AS prev_after
FROM unnest(ARRAY[7, 30, 90, 365]) AS w;

DROP MATERIALIZED VIEW signal_meta;

-- One row: the day the windows end on, when the signals were last computed,
-- and over how much data.
--   as_of             the newest autonomy award's day (see above)
--   refreshed_at      when the nightly refresh last ran; it can be months
--                     after as_of
--   first_award_day   the oldest award's day: how far back the record reaches
CREATE MATERIALIZED VIEW signal_meta AS
SELECT COALESCE(a.latest, current_date) AS as_of,
       now() AS refreshed_at,
       a.awards,
       (SELECT count(*) FROM signal_opportunities) AS opportunities,
       a.first_award_day,
       EXISTS (SELECT 1 FROM awards WHERE source = 'seed') AS sample
FROM (
    SELECT max(day) FILTER (WHERE day <= current_date) AS latest,
           count(*) AS awards,
           min(day) AS first_award_day
    FROM signal_awards
) a;

-- The windows, anchored on as_of: exactly the definition in 007.
CREATE OR REPLACE VIEW signal_windows WITH (security_invoker = true) AS
SELECT w AS window_days, m.as_of, m.as_of - w AS cur_after, m.as_of - 2 * w AS prev_after
FROM signal_meta m, unnest(ARRAY[7, 30, 90, 365]) AS w;

-- The two signals that store per-window figures were computed with windows
-- that ended on the day of the last refresh. Recompute them now, so a reader
-- between this migration and the next nightly refresh never sees figures from
-- one anchor beside dates from another.
REFRESH MATERIALIZED VIEW signal_funding;
REFRESH MATERIALIZED VIEW signal_solicitations;

-- The new signal_meta is a new relation: keep the public API roles off it, as
-- 007 did (see the note there).
DO $$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('REVOKE ALL ON signal_meta FROM %I', role_name);
            EXECUTE format('REVOKE ALL ON signal_windows FROM %I', role_name);
        END IF;
    END LOOP;
END
$$;
