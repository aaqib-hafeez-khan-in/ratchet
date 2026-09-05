-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Reconciliation on a cadence.
--
-- WHAT RUNS ON A TIMER IS THE REMEMBERING, NOT A FETCH. Ratchet has no vendor
-- credentials and no outbound access to a customer's systems, and this does not
-- change that: it cannot call Stripe to ask what really happened, and a design
-- where it could would be a far larger promise than this product makes. The
-- vendor's truth still arrives by POST /v1/reconcile, from the customer.
--
-- What was missing is that reconciliation was an act of memory. Nobody schedules
-- the thing they only remember when they are already suspicious, so the control
-- that finds ungated actions ran approximately never. The gate is the one thing
-- in the path that knows how long it has been, so the gate keeps the calendar and
-- says when a check is overdue.
--
-- Runs are recorded as COUNTS ONLY. The ungated keys are returned live to the
-- caller that asked, and that caller supplied the list in the first place, so
-- persisting them here would add a store of records about actions that bypassed
-- the gate while answering no question the counts do not. Coverage and drift are
-- count questions.
ALTER TABLE effect_policies
  ADD COLUMN reconcile_every_hours INTEGER
    CONSTRAINT reconcile_every_hours_sane
      CHECK (reconcile_every_hours BETWEEN 1 AND 8760),
  -- Notifying once per cadence, not once per sweep. Without this the loop would
  -- re-announce the same overdue check every few minutes until someone acted,
  -- which is how an alert channel gets muted.
  ADD COLUMN reconcile_due_notified_at TIMESTAMPTZ;

CREATE TABLE reconciliation_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  effect_type   TEXT NOT NULL,
  checked       INTEGER NOT NULL,
  gated         INTEGER NOT NULL,
  ungated       INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE reconciliation_runs IS
  'One POST /v1/reconcile, as counts. Deliberately holds no keys: the caller supplied them and gets the unmatched ones back live.';

-- The sweep asks one question per policy: when did this effect type last get
-- reconciled? Ordered so that answer is the first row.
CREATE INDEX reconciliation_runs_latest_idx
  ON reconciliation_runs (workspace_id, effect_type, created_at DESC);
