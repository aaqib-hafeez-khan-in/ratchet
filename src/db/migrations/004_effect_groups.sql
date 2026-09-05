-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
-- Reversible effect groups (agent sagas).
--
-- An agent declares that several effects form one unit of work and, for each,
-- how to undo it. If the unit fails partway, Ratchet returns the exact
-- compensation plan in reverse order.
--
-- The design property that makes this safe: a compensation is itself an effect,
-- gated by the same at-most-once machinery. Undo cannot double-execute, which
-- is the failure that makes hand-rolled rollback dangerous.

CREATE TABLE effect_groups (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Caller-chosen, stable, and unique per workspace, so a retried run rejoins
  -- its own group instead of starting a second one.
  group_key     TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','committed','unwinding','unwound','unwind_failed')),
  -- Why an unwind was requested. Recorded because "who decided to roll this
  -- back, and why" is the first question asked afterwards.
  unwind_reason TEXT,
  agent_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX effect_groups_key_idx ON effect_groups (workspace_id, group_key);
CREATE INDEX effect_groups_state_idx ON effect_groups (workspace_id, state, created_at DESC);
CREATE INDEX effect_groups_gc_idx ON effect_groups (expires_at);

ALTER TABLE effects
  -- Which unit of work this effect belongs to, if any.
  ADD COLUMN group_id TEXT REFERENCES effect_groups(id) ON DELETE SET NULL,
  -- How to undo this effect: {effect_type, payload}. Declared up front, at the
  -- moment the caller still knows what undoing means — not reconstructed later
  -- from an audit log by something guessing.
  ADD COLUMN compensation JSONB,
  -- Set when this effect IS a compensation, pointing at what it reverses.
  ADD COLUMN compensates_effect_id TEXT REFERENCES effects(id) ON DELETE SET NULL,
  -- Set on the ORIGINAL effect once its compensation has succeeded.
  ADD COLUMN compensated_at TIMESTAMPTZ,
  -- Ordering within the group. Compensation runs in reverse: the last thing
  -- done is the first thing undone.
  ADD COLUMN group_seq BIGINT;

CREATE INDEX effects_group_idx ON effects (group_id, group_seq)
  WHERE group_id IS NOT NULL;
-- Finds outstanding compensations: succeeded, reversible, not yet reversed.
CREATE INDEX effects_pending_compensation_idx ON effects (group_id)
  WHERE compensation IS NOT NULL AND compensated_at IS NULL AND state = 'succeeded';

CREATE SEQUENCE effect_group_seq;
