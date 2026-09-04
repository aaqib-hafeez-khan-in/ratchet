-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Feedback from the website.
--
-- Every complaint we have acted on arrived as a screenshot forwarded by the
-- operator. That is a sample of one person's inbox, and it is why each problem
-- took days to surface rather than minutes. This is the missing channel.
--
-- Deliberately NOT workspace-scoped. A reader who cannot understand the pricing
-- page does not have a workspace yet, and requiring one would exclude exactly
-- the people whose confusion matters most.

CREATE TABLE IF NOT EXISTS page_feedback (
  id            text PRIMARY KEY,
  path          text NOT NULL,
  -- The only structured signal, and the one worth counting: did this page do
  -- its job. A message is optional; this is not.
  was_clear     boolean NOT NULL,
  message       text,
  -- Optional, and only so we can reply. Never used to identify anyone across
  -- visits: there is no cookie, no fingerprint, and nothing joins to it.
  reply_to      text,
  -- Coarse context for reproducing a layout complaint. A width bucket, not a
  -- fingerprint — see the API for the buckets.
  viewport      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when a human has read it, so a digest never repeats itself.
  reviewed_at   timestamptz
);

-- The dashboard query is "which pages are confusing people, most recent first".
CREATE INDEX IF NOT EXISTS page_feedback_path_idx
  ON page_feedback (path, created_at DESC);

CREATE INDEX IF NOT EXISTS page_feedback_unreviewed_idx
  ON page_feedback (created_at DESC) WHERE reviewed_at IS NULL;

-- Abuse ceiling, enforced by the database rather than by counting in the
-- application. An unauthenticated write endpoint that stores free text is a
-- spam target; the API rate limit is per-IP and therefore evadable, so this
-- caps what any single minute can add regardless of where it came from.
CREATE TABLE IF NOT EXISTS page_feedback_windows (
  minute_start  timestamptz PRIMARY KEY,
  count         integer NOT NULL DEFAULT 0
);
