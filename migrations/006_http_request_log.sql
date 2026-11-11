-- 006_http_request_log: one row per request actually sent to an external
-- lookup API, written before the request goes out.
--
-- http_cache holds one row per distinct request (upserted on refresh), so it
-- undercounts: re-fetching an expired or failed entry updates the row in
-- place. Daily quotas (SAM.gov: 10 or 1,000 requests/day) are counted from
-- this append-only log instead. status stays NULL when the attempt ended in a
-- transport error. clock_timestamp(), not now(): the row must carry the time
-- of the request, not the start of whatever transaction it is written in.

CREATE TABLE IF NOT EXISTS http_requests (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    host         text        NOT NULL,
    cache_key    text        NOT NULL,   -- http_cache.cache_key of the request (no secrets)
    status       integer,                -- NULL until a response arrives
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS http_requests_host_requested_idx ON http_requests (host, requested_at);
