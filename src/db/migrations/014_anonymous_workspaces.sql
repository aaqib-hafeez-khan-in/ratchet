-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Keyless first contact.
--
-- An agent that discovers this service through the registry cannot use it: it
-- has no key, and getting one needs a human. Every product in this category has
-- that shape, and none of them have users. The services agents actually adopt
-- answer on the first call.
--
-- So the first call provisions its own workspace and returns a key with it. No
-- human, no email, no signup. The workspace is real but deliberately small:
-- enough to prove the thing works, not enough to run on. Adding an email later
-- claims it and lifts it to the normal free plan.

-- An anonymous workspace has nobody to email, so the column can no longer be
-- NOT NULL. Every read path already treats a missing owner as "no recipient".
ALTER TABLE workspaces ALTER COLUMN owner_email DROP NOT NULL;

ALTER TABLE workspaces
  ADD COLUMN anonymous  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN claimed_at TIMESTAMPTZ;

-- The reaper sweeps unclaimed, unused workspaces; without this it would have to
-- scan every workspace to find them.
CREATE INDEX workspaces_unclaimed
  ON workspaces (created_at)
  WHERE anonymous AND claimed_at IS NULL;
