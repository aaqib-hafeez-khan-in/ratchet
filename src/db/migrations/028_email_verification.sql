-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Verifying the address the free plan is attached to.
--
-- Claiming a workspace wrote owner_email and lifted the cap from 100 effects to
-- the free plan's 1,000. Nothing checked that the address existed. Measured: one
-- source could create five workspaces an hour, each a full free plan, with
-- addresses that were never reachable — and rotating addresses removed even that
-- bound.
--
-- The control gates the ALLOWANCE, not the signup. Anyone can still create a
-- workspace and get a working key in one request; it simply starts at the
-- unclaimed cap until the address answers. A legitimate person clicks a link and
-- is on the free plan. Someone farming plans now needs a real, reachable inbox
-- per workspace, which is the cost that was missing.
--
-- Deliberately NOT a ceiling on signups. Keyless provisioning can be refused
-- because there is a fallback — create one the ordinary way. Refusing a real
-- signup has no fallback, and blocking genuine customers during a launch spike
-- is a worse failure than serving an attacker a hundred free effects.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS email_verified_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_hash    TEXT,
  ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMPTZ;

-- Everything that already exists is grandfathered.
--
-- Without this, every workspace claimed before today silently drops from 1,000
-- effects to 100 the moment this deploys — including the one that runs our own
-- uptime monitoring. A security control that breaks existing customers on the
-- way in is not a security control, it is an outage with a rationale.
UPDATE workspaces
   SET email_verified_at = COALESCE(claimed_at, created_at)
 WHERE anonymous = false
   AND owner_email IS NOT NULL
   AND email_verified_at IS NULL;

-- The token is looked up by its hash on a path anyone can call, so it needs to
-- be found in one indexed hit rather than a scan.
CREATE INDEX IF NOT EXISTS workspaces_verification_idx
  ON workspaces (verification_hash) WHERE verification_hash IS NOT NULL;
