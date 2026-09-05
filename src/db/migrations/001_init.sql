-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Ratchet core schema.
-- Design notes:
--  * Every tenant-scoped table carries workspace_id and is always queried with it.
--  * Money is stored as integer micro-USD (1e-6 USD) to avoid float drift.
--  * The effects table is the single source of truth for the effect state machine.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- workspaces
CREATE TABLE workspaces (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  owner_email       TEXT NOT NULL,
  plan              TEXT NOT NULL DEFAULT 'free'
                      CHECK (plan IN ('free', 'starter', 'scale')),
                      -- Superseded by 002_plan_rename.sql, which collapses
                      -- starter/scale into a single 'pro' plan. Left as-is so
                      -- migrations replay in order on a fresh database.
  -- Prepaid credit balance in micro-USD; may be negative only via admin action.
  credit_micros     BIGINT NOT NULL DEFAULT 0,
  -- Rolling monthly allowance bookkeeping.
  period_start      TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  period_decisions  BIGINT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_owner_email_idx ON workspaces (lower(owner_email));

-- ------------------------------------------------------------------ api keys
-- Only a SHA-256 hash of the secret is stored. `prefix` is the public,
-- non-secret lookup handle shown in the console.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL UNIQUE,
  secret_hash   BYTEA NOT NULL,
  -- Least-privilege scopes, e.g. {effects:begin, effects:report, effects:read}
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  -- Optional hard ceiling this key may spend per UTC day, in micro-USD.
  daily_budget_micros BIGINT,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_workspace_idx ON api_keys (workspace_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------ effect policies
-- One row per (workspace, effect_type). Governs what happens at begin() time
-- and how an indeterminate outcome is resolved.
CREATE TABLE effect_policies (
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  effect_type        TEXT NOT NULL,
  -- 'allow' | 'require_approval' | 'deny'
  mode               TEXT NOT NULL DEFAULT 'allow'
                       CHECK (mode IN ('allow', 'require_approval', 'deny')),
  -- What a later caller may do when a prior attempt ended `indeterminate`.
  -- block  : never auto-retry; a human/agent must resolve it explicitly.
  -- retry  : the underlying vendor is idempotent or duplicates are harmless.
  -- probe  : caller must supply evidence of the real outcome to resolve.
  on_indeterminate   TEXT NOT NULL DEFAULT 'block'
                       CHECK (on_indeterminate IN ('block', 'retry', 'probe')),
  -- Lease duration handed to the executing agent, seconds.
  lease_seconds      INTEGER NOT NULL DEFAULT 60
                       CHECK (lease_seconds BETWEEN 5 AND 3600),
  -- Max attempts for the same idempotency key when retry is permitted.
  max_attempts       INTEGER NOT NULL DEFAULT 3
                       CHECK (max_attempts BETWEEN 1 AND 50),
  -- Cost governance, micro-USD. NULL = unlimited (subject to workspace budget).
  max_cost_micros    BIGINT,
  daily_budget_micros BIGINT,
  -- How long completed effect records (and their recorded results) are kept.
  retention_days     INTEGER NOT NULL DEFAULT 7
                       CHECK (retention_days BETWEEN 1 AND 400),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, effect_type)
);

-- ------------------------------------------------------------------- effects
-- The state machine.
--   awaiting_approval  policy requires a human/operator decision before a lease
--   pending            lease held by exactly one caller; work may be in progress
--   succeeded          caller reported success; result is replayable
--   failed             caller reported a clean failure (effect did NOT happen)
--   indeterminate      lease expired with no report; real-world outcome unknown
--   denied             blocked by policy, budget, or a rejected approval
--   cancelled          explicitly cancelled by an operator
-- Only `pending` ever holds a lease, so the reaper's sweep index stays small.
CREATE TABLE effects (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  effect_type       TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  -- SHA-256 over the canonical request payload. A second begin() with the same
  -- key but a different fingerprint is a caller bug and is rejected.
  fingerprint       BYTEA NOT NULL,

  state             TEXT NOT NULL
                      CHECK (state IN ('awaiting_approval','pending','succeeded',
                                       'failed','indeterminate','denied','cancelled')),

  -- Fencing token: monotonic per effect, incremented on every lease grant.
  -- A report is only accepted if it presents the current token.
  attempt           INTEGER NOT NULL DEFAULT 0,
  lease_token       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  leased_by_key_id  TEXT REFERENCES api_keys(id) ON DELETE SET NULL,

  -- Cost accounting, micro-USD.
  reserved_micros   BIGINT NOT NULL DEFAULT 0,
  actual_micros     BIGINT NOT NULL DEFAULT 0,

  -- Caller-supplied, opaque. Bounded in size by the API layer.
  request_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
  result            JSONB,
  failure_reason    TEXT,
  denial_reason     TEXT,

  -- Optional correlation for operators: which agent/run produced this.
  agent_id          TEXT,
  run_id            TEXT,

  approval_state    TEXT CHECK (approval_state IN ('waiting','approved','rejected')),
  approved_by       TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at        TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL
);

-- The uniqueness guarantee that makes at-most-once possible.
CREATE UNIQUE INDEX effects_ident_idx
  ON effects (workspace_id, effect_type, idempotency_key);

CREATE INDEX effects_workspace_created_idx ON effects (workspace_id, created_at DESC);
CREATE INDEX effects_state_idx ON effects (workspace_id, state, created_at DESC);
-- Drives the lease reaper; partial index keeps it tiny.
CREATE INDEX effects_lease_sweep_idx ON effects (lease_expires_at)
  WHERE state = 'pending';
CREATE INDEX effects_gc_idx ON effects (expires_at) WHERE state <> 'pending';
CREATE INDEX effects_run_idx ON effects (workspace_id, run_id) WHERE run_id IS NOT NULL;

-- --------------------------------------------------------------- spend ledger
-- Append-only. Balance changes are always paired with a ledger row inside the
-- same transaction, so the ledger fully explains every balance.
CREATE TABLE ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- reserve | commit | release | topup | adjustment | metering
  kind           TEXT NOT NULL
                   CHECK (kind IN ('reserve','commit','release','topup',
                                   'adjustment','metering')),
  -- Signed delta applied to workspaces.credit_micros.
  delta_micros   BIGINT NOT NULL,
  balance_after  BIGINT NOT NULL,
  effect_id      TEXT REFERENCES effects(id) ON DELETE SET NULL,
  -- Guarantees each economic event is recorded exactly once.
  dedupe_key     TEXT NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_dedupe_idx ON ledger_entries (workspace_id, dedupe_key);
CREATE INDEX ledger_workspace_idx ON ledger_entries (workspace_id, created_at DESC);

-- ------------------------------------------------------------- daily rollups
-- Declared EXTERNAL spend (the customer's own money spent at third parties),
-- used purely for budget ceilings. This is NOT Ratchet revenue and never
-- touches workspaces.credit_micros — that is tracked in ledger_entries.
-- A row holds reservations for in-flight effects plus actuals for settled ones.
CREATE TABLE spend_windows (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,      -- 'workspace' | 'key:<id>' | 'type:<name>'
  day           DATE NOT NULL,
  spent_micros  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, scope, day)
);

-- ------------------------------------------------------------------- audit
CREATE TABLE audit_events (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL,      -- 'key:<prefix>' | 'console:<email>' | 'system'
  subject_id    TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_workspace_idx ON audit_events (workspace_id, created_at DESC);

-- --------------------------------------------------------------- webhooks
CREATE TABLE webhook_endpoints (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,
  events        TEXT[] NOT NULL DEFAULT '{}',
  disabled_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_ws_idx ON webhook_endpoints (workspace_id) WHERE disabled_at IS NULL;

CREATE TABLE webhook_deliveries (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint_id    TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  state          TEXT NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued','delivering','delivered','dead')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error     TEXT,
  last_status    INTEGER,
  -- One delivery per (endpoint, event) — makes enqueue idempotent.
  dedupe_key     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX webhook_deliveries_dedupe_idx ON webhook_deliveries (endpoint_id, dedupe_key);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE state IN ('queued','delivering');

-- ------------------------------------------------------------ console access
CREATE TABLE console_sessions (
  id            TEXT PRIMARY KEY,     -- sha256 of the session cookie value
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX console_sessions_expiry_idx ON console_sessions (expires_at);

-- ------------------------------------------------------- payment idempotency
CREATE TABLE processed_payment_events (
  id           TEXT PRIMARY KEY,      -- provider event id
  provider     TEXT NOT NULL,
  workspace_id TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
