-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- x402 machine payments.
--
-- An agent that exhausts its anonymous quota currently hits a wall it cannot
-- get past without a human going to sign up. x402 lets it pay for more itself,
-- over HTTP, with no account.
--
-- AT-MOST-ONCE SETTLEMENT, which is the whole point of this product applied to
-- its own billing. An EIP-3009 authorization carries a nonce that is unique per
-- authorization, and the unique index below is what makes a replayed payment
-- impossible to settle twice — enforced by the database, not by application
-- logic, exactly as the effects table does it.
--
-- Note what is NOT stored: no signature, no authorization payload. We keep the
-- nonce to deduplicate and the settlement reference to reconcile, and nothing
-- that could be replayed if this table leaked.
CREATE TABLE x402_payments (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The EIP-3009 authorization nonce. Unique across the whole table: the same
  -- authorization must never be honoured twice, for any workspace.
  nonce          TEXT NOT NULL,
  network        TEXT NOT NULL,
  asset          TEXT NOT NULL,
  amount         TEXT NOT NULL,
  payer          TEXT,
  -- The on-chain transaction the facilitator reported. Null until settled.
  settlement_ref TEXT,
  state          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','settled','failed')),
  credit_micros  BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX x402_payments_nonce ON x402_payments (nonce);
CREATE INDEX x402_payments_workspace ON x402_payments (workspace_id, created_at DESC);
