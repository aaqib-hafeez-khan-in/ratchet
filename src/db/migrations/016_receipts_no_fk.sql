-- Drop the receipts -> workspaces foreign key.
--
-- Adding receipts to the decision path reintroduced the exact deadlock the
-- concurrency rules exist to prevent, and the integration tests caught it
-- immediately.
--
-- A foreign key takes a KEY SHARE lock on the parent workspaces row. Metering
-- later needs that same row EXCLUSIVELY. Two concurrent callers each holding
-- KEY SHARE and each waiting for EXCLUSIVE deadlock. beginEffect already avoids
-- this for the effects table by taking the exclusive lock FIRST for genuinely
-- new effects, and by letting duplicates and retries skip it entirely — and a
-- receipt is written on EVERY decision, including those duplicates, so the
-- receipt insert put a KEY SHARE lock back on precisely the path that was
-- carefully built not to take one.
--
-- Receipts are an append-only log, not relational data: nothing joins to them
-- for correctness, and nothing cascades through them. The referential integrity
-- was worth less than the contention it cost. The worker deletes receipts for
-- vanished workspaces instead, which preserves the property that actually
-- matters -- deleting a workspace deletes its audit trail -- without holding a
-- lock on the request path.
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_workspace_id_fkey;

-- Lets the worker find receipts whose workspace is gone without a full scan.
CREATE INDEX IF NOT EXISTS receipts_workspace ON receipts (workspace_id);
