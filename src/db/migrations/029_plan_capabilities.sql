-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Capability gates, and the promise that nobody loses what they already have.
--
-- Every plan limit until now has been a number: effects, keys, webhooks,
-- retention days, requests per minute. All of them are enforced. What did not
-- exist was any capability a paid plan has and a free one does not, which is a
-- reasonable thing for a paid plan to offer and the reason this is being added.
--
-- WHAT IS DELIBERATELY NOT GATED. Everything that keeps an agent from doing
-- damage stays on the free plan: at-most-once, every policy mode, indeterminate
-- handling, surge containment, run budgets, recall, approvals, webhooks and the
-- audit trail. Selling safety by the tier would make the product worse for the
-- people least able to pay for it, and this product's entire argument is that
-- the safe thing should be the easy thing. The gates are on evidence, recovery
-- and scale instead.
--
-- WHY A GRANDFATHER FLAG RATHER THAN A DATE. Every workspace that exists right
-- now can call these endpoints. Turning that off underneath them would be the
-- same demotion this codebase has already had to correct once, when email
-- verification nearly dropped every existing customer from 1,000 effects to
-- 100. The rule here is simpler than a cutoff date and easier to reason about:
-- a workspace that exists today keeps everything it can do today, for as long
-- as it exists. The gate applies only to workspaces created after it.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS legacy_capabilities BOOLEAN NOT NULL DEFAULT false;

UPDATE workspaces SET legacy_capabilities = true;

COMMENT ON COLUMN workspaces.legacy_capabilities IS
  'Predates plan capability gating (migration 029). Keeps access to capabilities '
  'its plan would not otherwise grant. Never set this on a new workspace.';
