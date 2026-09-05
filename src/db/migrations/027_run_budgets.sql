-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
-- A wallet for one unit of agent work.
--
-- Budgets already exist, bound to an API key or an effect type, and reset every
-- day. Neither shape fits the thing people actually want to bound: "this task
-- may spend fifty dollars." A task is not a day and it is not a key — one key
-- runs a thousand tasks, and a task that starts at 23:50 would otherwise be
-- handed a fresh allowance ten minutes later.
--
-- So this is a separate table rather than another scope in spend_windows, whose
-- primary key includes `day` precisely because those budgets are meant to
-- refill. A run's wallet must not.
--
-- The column that matters is `limit_micros`. It is set once, by whoever starts
-- the run, and the gate refuses the effect that would cross it — before the
-- money moves, which is the only moment where refusing is still cheap.

CREATE TABLE IF NOT EXISTS run_budgets (
  workspace_id  TEXT   NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT   NOT NULL,
  limit_micros  BIGINT NOT NULL CHECK (limit_micros >= 0),
  spent_micros  BIGINT NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id)
);

-- Runs are finite and eventually uninteresting; the reaper needs to find the
-- old ones without scanning every wallet ever opened.
CREATE INDEX IF NOT EXISTS run_budgets_gc_idx ON run_budgets (created_at);
