-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Receipt retention, and making a receipt self-contained.
--
-- TWO PROBLEMS.
--
-- 1. Receipts grew without bound. One row per decision, forever, with no
--    cleanup path. At any real volume it becomes the largest table in the
--    database and nothing ever removes a row.
--
-- 2. The prevented-loss figure JOINed receipts to effects to find the declared
--    cost, but effects are deleted after their retention window — seven days by
--    default. The endpoint advertises a THIRTY day window, so past day seven it
--    silently lost rows and under-reported. The number meant to make the gate's
--    value visible was quietly shrinking on its own.
--
-- Carrying the cost on the receipt fixes the second and is the right shape
-- anyway: an audit record that depends on another table still existing is not
-- self-contained evidence.
ALTER TABLE receipts ADD COLUMN cost_micros BIGINT NOT NULL DEFAULT 0;

-- Pruning a hash chain naively BREAKS it. auditChain walks from the first
-- receipt and checks each link against the one before; delete the head and
-- every remaining receipt looks discontinuous, so every customer's audit would
-- start failing — worse than unbounded growth, because it destroys the trust
-- the receipts existed to create.
--
-- So a prune is preceded by a signed checkpoint: an attestation that the chain
-- ran continuously up to seq N and terminated at hash H. The audit then starts
-- from the checkpoint rather than from seq 1, and continuity is preserved
-- across the gap.
--
-- The honest limitation, documented rather than hidden: once pruned, an
-- individual old receipt can no longer be re-verified. The checkpoint proves
-- the chain was intact when we signed it. A customer who needs to keep the
-- underlying receipts must retain their own copies.
CREATE TABLE receipt_checkpoints (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  up_to_seq     BIGINT NOT NULL,
  chain_hash    TEXT NOT NULL,
  pruned_count  INTEGER NOT NULL,
  body          TEXT NOT NULL,
  signature     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX receipt_checkpoints_ws ON receipt_checkpoints (workspace_id, up_to_seq DESC);

-- The prune scans by age within a workspace.
CREATE INDEX receipts_ws_created ON receipts (workspace_id, created_at);
