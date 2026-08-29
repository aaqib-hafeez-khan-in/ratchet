-- Two plans replace three. `starter` and `scale` collapse into `pro`.
--
-- Any workspace on a legacy plan keeps paid status rather than being demoted to
-- free: silently reducing a paying customer's entitlement would be worse than
-- carrying them at a price they did not choose until they are contacted.

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_plan_check;

UPDATE workspaces SET plan = 'pro' WHERE plan IN ('starter', 'scale');

ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check
  CHECK (plan IN ('free', 'pro'));
