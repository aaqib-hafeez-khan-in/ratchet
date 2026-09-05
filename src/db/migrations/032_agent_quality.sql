-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Two facts we were throwing away, and the index to read them by agent.
--
-- Both are written by the UPDATE that grants a lease, so neither costs a round
-- trip. Neither is read on any hot path.
--
--   lease_granted_at  When permission was actually taken. `created_at` is when
--                     the effect was first asked about, which for a retried
--                     effect can be hours earlier, so it cannot answer "how long
--                     does this agent hold a lease before reporting".
--
--   declared_micros   What the caller said the effect would cost. reserved_micros
--                     is zeroed on report — correctly, it is a live reservation —
--                     which erased the only record of the estimate. Without it,
--                     "does this agent know what its actions cost before it takes
--                     them" is unanswerable after the fact, and a budget ceiling
--                     is only as good as the numbers declared against it.
--
-- Both are NULL/0 for every effect begun before this migration. The reliability
-- endpoint reports how many effects it could actually measure rather than
-- averaging over rows that never carried the field.
ALTER TABLE effects
  ADD COLUMN lease_granted_at TIMESTAMPTZ,
  ADD COLUMN declared_micros  BIGINT NOT NULL DEFAULT 0;

-- Every reliability query is (workspace, agent, recent). Partial, because the
-- overwhelming majority of effects in a young workspace carry no agent_id.
CREATE INDEX effects_agent_idx ON effects (workspace_id, agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;
