-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Declared dimensions, and the ceilings that can be keyed on them.
--
-- Until now a ceiling could be scoped to a workspace, an API key, or an effect
-- type. None of those answers the question a risk team actually asks: "how much
-- has gone to THAT destination today." Twenty distinct $500 refunds to one bank
-- account passed every check in this system.
--
-- The obstacle was that Ratchet never sees a payload, deliberately, and a
-- destination lives in the payload. The way through is that counting does not
-- require reading: the caller declares a dimension, and only an HMAC of it is
-- ever stored. Ratchet cannot say who the counterparty is, cannot reverse the
-- value, and cannot correlate it with another workspace — the workspace id is
-- inside the MAC — but it can count.
--
-- A DECLARED DIMENSION IS A CLAIM BY THE CALLER, AND CAN ONLY TIGHTEN.
-- Declaring one adds a ceiling; it never removes the workspace, key or type
-- ceilings that already applied. Omitting a required one is refused rather than
-- allowed. Lying about the value moves the effect to a different bucket but
-- grants nothing that was not already permitted — and reconciliation against the
-- vendor's own record is what catches a lie, since the vendor knows the real
-- destination.

-- Blinded dimensions, as {name: <32 hex chars>}. Never the values themselves.
ALTER TABLE effects ADD COLUMN dimensions JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The scopes a lease actually reserved against, so a release reverses exactly
-- what was taken. Derived data, deliberately: policy can be edited between a
-- begin and its report, and recomputing the scopes at release time would then
-- return a reservation to the wrong bucket or fail to return it at all. Written
-- by the UPDATE that grants the lease, so it costs no round trip.
ALTER TABLE effects ADD COLUMN reserved_dimension_scopes TEXT[] NOT NULL DEFAULT '{}';

-- Velocity, alongside spend. A ceiling of "no more than five of these per day"
-- has no monetary component at all, and outbound messaging is the case that
-- needs it most.
ALTER TABLE spend_windows ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE effect_policies
  -- Dimensions that must be present, or begin is refused. Without this, a
  -- compromised agent evades a counterparty ceiling by simply not declaring one.
  ADD COLUMN required_dimensions TEXT[] NOT NULL DEFAULT '{}',
  -- {"counterparty": {"daily_micros": 200000000, "daily_count": 20}}
  ADD COLUMN dimension_limits    JSONB  NOT NULL DEFAULT '{}'::jsonb;

-- Fan-in and fan-out are cardinality questions over this column, so the index is
-- on the blinded value rather than the row.
CREATE INDEX effects_dimensions_idx ON effects USING gin (dimensions jsonb_path_ops)
  WHERE dimensions <> '{}'::jsonb;
