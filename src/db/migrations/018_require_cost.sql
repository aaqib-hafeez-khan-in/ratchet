-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Let an operator require a declared cost.
--
-- Budget ceilings are computed from the cost the caller declares on begin. That
-- field is optional and defaults to zero, and reserveSpend returns immediately
-- when the amount is zero — so a workspace can configure a $100/day ceiling,
-- believe it is protected, and have the check never run a single time.
--
-- A safety feature that silently does nothing is worse than an absent one,
-- because the operator stops watching. This flag lets them close it: with
-- require_cost on, an effect of that type is refused unless it declares what it
-- will cost, which turns a silent gap into an explicit decision.
--
-- Defaults to false so no existing workspace starts refusing traffic on
-- deploy. Turning it on is the operator's call, and the begin response now
-- warns whenever a ceiling exists but nothing is being counted toward it.
ALTER TABLE effect_policies
  ADD COLUMN require_cost BOOLEAN NOT NULL DEFAULT false;
