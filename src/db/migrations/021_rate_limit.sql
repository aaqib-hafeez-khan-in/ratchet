-- Shared rate-limit counters.
--
-- @fastify/rate-limit keeps counts in process memory, so an N-instance
-- deployment allows roughly N times the configured rate. The manifest publishes
-- exact per-plan numbers (free 120/min, pro 600, scale 3000), and Fly is
-- configured to auto-start a second machine under load — so the moment it did,
-- every published limit doubled.
--
-- One row per (bucket, window). Instances add their own delta and read back the
-- global total; nothing here is on the request path.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key   text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- The sweep deletes whole expired windows; ordering by window_start makes that
-- a range scan rather than a sequential scan of every live bucket.
CREATE INDEX IF NOT EXISTS rate_limit_counters_window_idx
  ON rate_limit_counters (window_start);
