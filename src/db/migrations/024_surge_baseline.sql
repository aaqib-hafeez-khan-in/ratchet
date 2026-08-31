-- Relative surge thresholds.
--
-- `surge_per_hour` requires knowing your own traffic. Most people do not, which
-- makes the safest setting the one hardest to choose — and the workspaces least
-- likely to have configured anything are exactly the ones a runaway agent will
-- hurt most.
--
-- `surge_multiplier` asks a question anyone can answer instead: how many times
-- normal is definitely wrong? The baseline it multiplies is the median of this
-- effect type's hourly volume over the last seven days.
--
-- The baseline is a STORED column, recomputed by the worker, not derived on
-- demand. Computing a median per request would put a growing aggregate on the
-- decision path — the busiest callers paying most for the check that protects
-- them, which is precisely backwards. The hot path reads a number that is
-- already on the policy row it had to load anyway, so this costs nothing.
ALTER TABLE effect_policies
  ADD COLUMN IF NOT EXISTS surge_multiplier        integer,
  ADD COLUMN IF NOT EXISTS surge_baseline_per_hour integer,
  ADD COLUMN IF NOT EXISTS surge_baseline_at       timestamptz;

-- Below 2x, "a multiple of normal" stops meaning anything.
ALTER TABLE effect_policies
  ADD CONSTRAINT effect_policies_surge_multiplier_ck
  CHECK (surge_multiplier IS NULL OR surge_multiplier >= 2);
