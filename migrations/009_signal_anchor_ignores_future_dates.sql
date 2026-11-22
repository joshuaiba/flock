-- The signal windows end on the newest record that is not dated after today.
--
-- 008 set as_of to LEAST(current_date, the newest record's day), meant as "a
-- future-dated record cannot drag the windows past today". But one such
-- record does more than that: the newest day is then in the future, LEAST
-- picks current_date, and every window ends on the calendar again. With the
-- record ~90 days behind (USAspending publishes Defense contracts about 90
-- days after signing), one award or solicitation dated even a day ahead, by a
-- typo in a source, empties the 7, 30 and 90-day windows: the fault 008 was
-- written to fix.
--
-- as_of is now the newest day among awards and solicitations dated on or
-- before today; a record dated after today is left out of the choice (and,
-- being after as_of, out of every window until the calendar reaches it). The
-- rest of 008's rule is unchanged: flock.signals_as_of pins the day for one
-- refresh, and an empty record (or one dated only in the future) ends on
-- today.
--
-- Only signal_meta's expression changes. A materialized view cannot be
-- redefined in place, and signal_windows depends on it, so signal_windows is
-- pointed away from it for a moment (same columns and types), signal_meta is
-- created again, and signal_windows is restored to 008's definition, all in
-- this migration's transaction. The two signals that store per-window figures
-- are refreshed at the end, so a migrated database is consistent before the
-- next nightly refresh.

CREATE OR REPLACE VIEW signal_windows WITH (security_invoker = true) AS
SELECT w AS window_days, NULL::date AS as_of, NULL::date AS cur_after, NULL::date AS prev_after
FROM unnest(ARRAY[7, 30, 90, 365]) AS w;

DROP MATERIALIZED VIEW signal_meta;

CREATE MATERIALIZED VIEW signal_meta AS
SELECT COALESCE(
           NULLIF(current_setting('flock.signals_as_of', true), '')::date,
           GREATEST(
               (SELECT max(day) FROM autonomy_awards WHERE day <= current_date),
               (SELECT max(day) FROM autonomy_opportunities WHERE day <= current_date)
           ),
           current_date
       ) AS as_of,
       now() AS refreshed_at,
       (SELECT count(*) FROM autonomy_awards) AS awards,
       (SELECT count(*) FROM autonomy_opportunities) AS opportunities,
       (SELECT min(day) FROM autonomy_awards) AS first_award_day,
       EXISTS (SELECT 1 FROM awards WHERE source = 'seed') AS sample;

CREATE OR REPLACE VIEW signal_windows WITH (security_invoker = true) AS
SELECT w AS window_days, m.as_of, m.as_of - w AS cur_after, m.as_of - 2 * w AS prev_after
FROM signal_meta m, unnest(ARRAY[7, 30, 90, 365]) AS w;

REFRESH MATERIALIZED VIEW signal_funding;
REFRESH MATERIALIZED VIEW signal_solicitations;

-- The new signal_meta is a new relation: keep the public API roles off it, as
-- 007 and 008 do (see the note there).
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
