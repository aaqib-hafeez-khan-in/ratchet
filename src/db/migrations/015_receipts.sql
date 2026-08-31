-- Signed decision receipts.
--
-- A gate's value is invisible when it works: you never see the charge that did
-- not happen. "Trust us, we prevented it" is unfalsifiable, which is a bad
-- position for a product whose entire pitch is rigour. A receipt makes each
-- decision checkable by the customer, offline, against a published key.
--
-- WHY THE CHAIN IS BUILT ASYNCHRONOUSLY
--
-- Tamper-evidence wants an ordered chain per workspace, and an ordered chain
-- wants a serialisation point. Taking one on every decision would mean an
-- exclusive workspace lock on the hot path, which is exactly the contention the
-- lock-ordering work exists to avoid: duplicates and retries currently skip the
-- workspace lock entirely, and that is why they are fast.
--
-- So a receipt is SIGNED synchronously (cheap, lock-free, immediately
-- verifiable on its own) and CHAINED afterwards by the worker, which walks
-- unchained receipts in id order and links them. That is the same shape as a
-- transparency log: individual signatures prove authorship straight away, and
-- the chain proves nothing was removed later.
CREATE TABLE receipts (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  effect_id     TEXT NOT NULL,
  decision      TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  -- The exact bytes that were signed. Kept verbatim so verification never
  -- depends on us re-serialising the same way twice.
  body          TEXT NOT NULL,
  signature     TEXT NOT NULL,
  body_hash     TEXT NOT NULL,

  -- Filled by the worker. NULL means signed but not yet chained.
  seq           BIGINT,
  prev_hash     TEXT,
  chain_hash    TEXT,
  chained_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX receipts_effect ON receipts (effect_id);
CREATE INDEX receipts_workspace_seq ON receipts (workspace_id, seq);
-- The worker's work queue: only rows still waiting to be chained.
CREATE INDEX receipts_unchained ON receipts (workspace_id, id) WHERE seq IS NULL;

-- One row per workspace tracking the head of its chain, so appending is a
-- single indexed read rather than a scan.
CREATE TABLE receipt_chains (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_seq      BIGINT NOT NULL DEFAULT 0,
  last_hash     TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
