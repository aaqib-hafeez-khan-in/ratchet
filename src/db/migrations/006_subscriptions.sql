-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Recurring subscription billing.
--
-- Until now a workspace could buy prepaid credit but could not subscribe to a
-- plan, so Pro was advertised at $29/mo and was not purchasable. Plans were
-- changed only by direct database edit.
--
-- The provider's own identifiers are stored so a subscription can be reconciled
-- both ways: from a webhook to a workspace, and from a workspace to the
-- provider when someone asks "what is this account actually paying for?"
ALTER TABLE workspaces
  ADD COLUMN stripe_customer_id     TEXT,
  ADD COLUMN stripe_subscription_id TEXT,
  -- Mirrors the provider's status. `past_due` still grants entitlement: cutting
  -- off a paying customer over a temporarily declined card would cause exactly
  -- the duplicate this service prevents.
  ADD COLUMN subscription_status    TEXT
    CHECK (subscription_status IN ('active','past_due','canceled','incomplete')),
  ADD COLUMN subscription_ends_at   TIMESTAMPTZ;

CREATE UNIQUE INDEX workspaces_stripe_sub_idx ON workspaces (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX workspaces_stripe_cust_idx ON workspaces (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
