-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
-- ---------------------------------------------------------------- refunds
-- Reversing a credit requires finding the credit that a Stripe charge created.
-- The payment intent is the durable link between the two, so record it when the
-- credit is applied rather than trying to reconstruct it later.
ALTER TABLE ledger_entries ADD COLUMN payment_reference TEXT;
CREATE INDEX ledger_payment_ref_idx ON ledger_entries (payment_reference)
  WHERE payment_reference IS NOT NULL;

-- --------------------------------------------------------------- analytics
-- Effect records are deleted at their retention horizon (7 days on Free), which
-- would erase the evidence needed for cohort analysis. These two tables are
-- deliberately outside that lifecycle: they are tiny, they are never garbage
-- collected, and they hold no payload, no result, and no personal data beyond
-- the workspace id that already exists.

-- One row per workspace per UTC day with activity. Bounded by
-- (workspaces x days), so it stays small no matter how many effects run.
CREATE TABLE workspace_activity (
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day                    DATE NOT NULL,
  effects_begun          BIGINT NOT NULL DEFAULT 0,
  effects_succeeded      BIGINT NOT NULL DEFAULT 0,
  effects_indeterminate  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
CREATE INDEX workspace_activity_day_idx ON workspace_activity (day);

-- One row per workspace per milestone, recorded the first time only. This is
-- what makes activation rate and time-to-first-workflow answerable.
CREATE TABLE workspace_milestones (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  milestone     TEXT NOT NULL,
  reached_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, milestone)
);
CREATE INDEX workspace_milestones_idx ON workspace_milestones (milestone, reached_at);
