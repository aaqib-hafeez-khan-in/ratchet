-- Reintroduce a volume tier. `scale` existed in the original three-tier ladder,
-- was collapsed into `pro` when that ladder was found to price a 20x usage
-- range at one number, and returns now with a volume that is actually reachable
-- and limits the code enforces.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check
  CHECK (plan IN ('free', 'pro', 'scale'));
