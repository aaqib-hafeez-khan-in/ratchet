-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
-- Approval triggered by how much is at stake, rather than by effect type.
--
-- `mode = 'require_approval'` is all-or-nothing: every refund waits for a human,
-- or none does. That is not the rule anyone actually states. The rule finance
-- teams state in their first sentence is "anything over five thousand needs a
-- second pair of eyes" — a threshold, not a category. Without one, an operator
-- picks between reviewing three hundred trivial refunds a day and reviewing none
-- of them, and every real deployment picks none.
--
-- This sits BELOW max_cost_micros, which refuses outright. Together they read as
-- the sentence people mean: allow up to the threshold, hold for a human between
-- the threshold and the ceiling, refuse above the ceiling. A threshold above the
-- ceiling can never fire, since the ceiling has already refused the request, so
-- upsertPolicy rejects that configuration rather than storing a dead control.
--
-- It keys on the amount the CALLER DECLARED, which is the same exposure
-- max_cost_micros has always had: an agent that under-declares lands under the
-- threshold. That is why setting this implies require_cost — an approval line
-- nothing counts toward is not a line — and why POST /v1/reconcile against the
-- vendor's own record is what catches an amount that was declared dishonestly.
ALTER TABLE effect_policies
  ADD COLUMN approval_above_micros BIGINT
    CONSTRAINT approval_above_micros_positive CHECK (approval_above_micros > 0);

COMMENT ON COLUMN effect_policies.approval_above_micros IS
  'Declared cost at or above which begin returns approval_required instead of execute. Raises the mode; never lowers it. Null disables it.';
