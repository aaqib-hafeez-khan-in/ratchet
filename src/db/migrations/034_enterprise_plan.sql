-- A fourth plan, and the only one that cannot be bought.
--
-- Enterprise exists because the fraud and risk controls brought a different
-- buyer, not a different feature. The controls themselves ship on every plan —
-- a per-destination ceiling is a safety property, and "the ceiling exists, you
-- were on the wrong plan" is not a sentence this product can afford to say. What
-- a risk function needs on top is operational: retention it can name in a
-- policy, headroom it will not trip over, and a contract.
--
-- Nothing here grants a capability that a paying Scale workspace does not
-- already have. The difference is limits and terms.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check
  CHECK (plan IN ('free', 'pro', 'scale', 'enterprise'));
