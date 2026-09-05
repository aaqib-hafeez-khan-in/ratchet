-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Automatic credit top-up, and the machinery that keeps it from firing twice.
--
-- Overage draws on prepaid credit, and at a zero balance the effect is REFUSED.
-- That is the right default — nothing is ever billed by surprise — but it means
-- a customer who is using the product successfully hits a wall at 3am. This
-- lets them opt into "keep me topped up" instead.
--
-- THE RISK, STATED PLAINLY. This charges a real card with no human present. A
-- bug here does not lose data, it takes money repeatedly from somebody who
-- trusted us — and it would do so in a product whose entire argument is that
-- the same action must happen at most once. Getting this wrong would be worse
-- for us than for almost anyone else building it.
--
-- So the at-most-once guarantee is enforced the same way the product's own is:
-- by a unique index in the database, not by application logic. `trigger_key` is
-- the sequence number of the recharge for that workspace, so two concurrent
-- pollers computing the same number collide on the index and exactly one wins.
-- The Stripe call then carries the row id as its idempotency key, so even a
-- retried HTTP request cannot produce a second charge.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS auto_recharge_enabled BOOLEAN NOT NULL DEFAULT false,
  -- Recharge when the balance falls below this. NULL while never configured.
  ADD COLUMN IF NOT EXISTS auto_recharge_threshold_micros BIGINT,
  ADD COLUMN IF NOT EXISTS auto_recharge_pack_id TEXT,
  -- Set when we switch it off ourselves — a declined card, a missing payment
  -- method. Shown to the operator so the silence is explained rather than
  -- discovered.
  ADD COLUMN IF NOT EXISTS auto_recharge_disabled_reason TEXT;

CREATE TABLE IF NOT EXISTS credit_recharges (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The at-most-once key: 'seq:<n>' where n is how many recharges came before.
  -- Two pollers seeing the same low balance derive the same key and only one
  -- row can exist.
  trigger_key    TEXT NOT NULL,
  pack_id        TEXT NOT NULL,
  amount_micros  BIGINT NOT NULL CHECK (amount_micros > 0),
  -- pending: the charge was attempted and the outcome is not yet known. It is
  -- deliberately NOT auto-resolved; the same rule the product applies to its
  -- customers' effects applies to our own money.
  state          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','succeeded','failed')),
  payment_intent_id TEXT,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at     TIMESTAMPTZ
);

-- The guarantee. Everything else is convenience.
CREATE UNIQUE INDEX IF NOT EXISTS credit_recharges_once
  ON credit_recharges (workspace_id, trigger_key);

-- The daily-cap query and the "is one already in flight" check.
CREATE INDEX IF NOT EXISTS credit_recharges_recent
  ON credit_recharges (workspace_id, created_at DESC);

COMMENT ON TABLE credit_recharges IS
  'One row per automatic top-up attempt. Unique on (workspace_id, trigger_key) '
  'so a concurrent poller cannot start a second charge for the same shortfall.';
