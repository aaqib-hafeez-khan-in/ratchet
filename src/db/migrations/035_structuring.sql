-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- A threshold Ratchet watches but does not enforce.
--
-- Structuring is keeping amounts just under a line so the line never triggers.
-- Ratchet is unusually placed to see it, because it is the only thing in the
-- path that knows what the line IS — but the line that matters is usually not
-- one Ratchet owns. A reporting threshold, an internal review limit, a
-- counterparty's own rule: none of those are enforced here, and all of them get
-- hugged.
--
-- Knowing the amounts is enough to detect bunching under a threshold. Owning the
-- threshold is not required. So this column enforces NOTHING — an effect above
-- it is not refused, and no ceiling is derived from it. It exists solely so the
-- analysis has a line to measure distance from.
--
-- Where it is null, max_cost_micros is used instead, since a ceiling that DOES
-- refuse is a line worth hugging too.
ALTER TABLE effect_policies
  ADD COLUMN structuring_threshold_micros BIGINT;

COMMENT ON COLUMN effect_policies.structuring_threshold_micros IS
  'Observation only. Never enforced; used by the structuring analysis as the line to measure bunching against.';

-- The analysis reads declared amounts for one workspace over a window.
CREATE INDEX effects_declared_idx ON effects (workspace_id, effect_type, created_at DESC)
  WHERE declared_micros > 0;
