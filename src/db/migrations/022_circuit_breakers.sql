-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Surge containment: stop an agent that has started doing far more than it ever
-- did before, without stopping the ones behaving normally.
--
-- Budget ceilings catch an agent spending too much. Nothing catches an agent
-- doing too MUCH — a loop that sends five thousand emails instead of three, or
-- starts charging cards it has never charged. That is the failure people
-- actually fear from autonomous agents, and the gate is the only place that can
-- see it coming, because every intended effect passes through here first.
--
-- The response is deliberately not "kill the agent". A tripped breaker raises
-- the effect type to require_approval, so a human decides and the agent waits
-- rather than dying. Operators who want a hard stop can choose deny.

-- Per-effect-type surge configuration. NULL threshold means the feature is off,
-- which is the default: this must never surprise an existing workspace.
ALTER TABLE effect_policies
  ADD COLUMN IF NOT EXISTS surge_per_hour          integer,
  ADD COLUMN IF NOT EXISTS surge_action            text    NOT NULL DEFAULT 'require_approval',
  ADD COLUMN IF NOT EXISTS surge_cooldown_seconds  integer NOT NULL DEFAULT 3600;

ALTER TABLE effect_policies
  ADD CONSTRAINT effect_policies_surge_action_ck
  CHECK (surge_action IN ('monitor', 'require_approval', 'deny'));

ALTER TABLE effect_policies
  ADD CONSTRAINT effect_policies_surge_per_hour_ck
  CHECK (surge_per_hour IS NULL OR surge_per_hour > 0);

-- How many NEW effects of each type a workspace created in each hour.
--
-- Counted rather than derived: a COUNT over the effects table on every begin
-- would grow with the workspace's own history, which is precisely backwards —
-- the busiest callers would pay the most for the check that protects them.
--
-- NO FOREIGN KEY to workspaces, on purpose. A foreign key takes a KEY SHARE
-- lock on the parent row, and this table is written inside the decision
-- transaction that already holds that row exclusively. Receipts learned this
-- the hard way (migration 016): the FK turned a 43 ms concurrency test into
-- 1021 ms. Orphan rows are collected by the reaper instead.
CREATE TABLE IF NOT EXISTS effect_rate_windows (
  workspace_id text        NOT NULL,
  effect_type  text        NOT NULL,
  hour_start   timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, effect_type, hour_start)
);

CREATE INDEX IF NOT EXISTS effect_rate_windows_hour_idx
  ON effect_rate_windows (hour_start);

-- One row per (workspace, effect type) that has ever tripped or been opened by
-- hand. effect_type '*' is the workspace-wide emergency stop.
CREATE TABLE IF NOT EXISTS circuit_breakers (
  workspace_id text        NOT NULL,
  effect_type  text        NOT NULL,
  state        text        NOT NULL DEFAULT 'closed',
  action       text        NOT NULL DEFAULT 'require_approval',
  tripped_at   timestamptz,
  resets_at    timestamptz,
  observed     integer,
  threshold    integer,
  reason       text,
  opened_by    text,
  -- Closing a breaker must give the effect type a fresh allowance, otherwise a
  -- cooldown is meaningless: the hour's count is still above the ceiling, so
  -- the very next effect re-trips it. Rather than zeroing the counter — which
  -- would corrupt the rate history operators use to pick a threshold — the
  -- breaker remembers the count it was cleared at and the surge check measures
  -- from there.
  baseline_count integer   NOT NULL DEFAULT 0,
  baseline_hour  timestamptz,
  trip_count   integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, effect_type),
  CONSTRAINT circuit_breakers_state_ck  CHECK (state IN ('closed', 'open')),
  CONSTRAINT circuit_breakers_action_ck CHECK (action IN ('monitor', 'require_approval', 'deny'))
);

-- The decision path looks up open breakers for one workspace on every new
-- effect; a partial index keeps that to the few rows that are actually open.
CREATE INDEX IF NOT EXISTS circuit_breakers_open_idx
  ON circuit_breakers (workspace_id) WHERE state = 'open';
