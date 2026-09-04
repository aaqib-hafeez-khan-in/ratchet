-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Keyless workspace provisioning, counted where it cannot be forgotten.
--
-- The ceiling used to be a Map in the API process. Three things were wrong with
-- that, and only the first was written down:
--
--   It is per instance, so the real limit was (instances x limit).
--   It resets on deploy, so the limit was really "per instance per deploy".
--   It is keyed on IP alone, and an address is the cheapest thing on the
--   internet to rotate.
--
-- The original comment justified the Map on the grounds that an unclaimed
-- workspace is small and gets swept. That is true and it answers the wrong
-- question: the risk was never table growth, it is that 20 workspaces an hour
-- at 100 effects each is 2,000 free gated effects an hour from one address,
-- against a free PLAN of 1,000 a month.

-- Per-source counter. The source is a keyed hash of the address, never the
-- address: we need to count repeat offenders, not know who they are, and an IP
-- log is a liability we have no use for.
CREATE TABLE IF NOT EXISTS provision_windows (
  source_hash   text        NOT NULL,
  hour_start    timestamptz NOT NULL,
  count         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (source_hash, hour_start)
);

-- The global ceiling, which is the one that survives address rotation. A single
-- row per hour, so the check is one indexed lookup.
CREATE TABLE IF NOT EXISTS provision_global (
  hour_start    timestamptz PRIMARY KEY,
  count         integer     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS provision_windows_gc_idx ON provision_windows (hour_start);
