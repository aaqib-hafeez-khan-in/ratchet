-- Transactional email.
--
-- Shaped like webhook delivery, which is already proven here: a durable queue,
-- a worker that retries with backoff, and a dedupe key that makes enqueuing
-- idempotent. Nothing sends from inside a request.
--
-- The dedupe key carries a TIME BUCKET, which is what stops a storm. Five
-- hundred effects going indeterminate in an hour produce one email, not five
-- hundred, because they all collapse onto the same key. That is the difference
-- between a useful alert and a reason to filter the sender.

CREATE TABLE email_messages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  to_email      TEXT NOT NULL,
  category      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  body_html     TEXT,
  -- Collapses duplicates within a window. Unique per workspace.
  dedupe_key    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','sending','sent','dead','suppressed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_id   TEXT,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX email_dedupe_idx ON email_messages (workspace_id, dedupe_key);
CREATE INDEX email_due_idx ON email_messages (next_attempt_at) WHERE state = 'queued';
CREATE INDEX email_ws_idx ON email_messages (workspace_id, created_at DESC);

-- Per-category opt-out. Absence means enabled: a new alert category should
-- reach people who signed up before it existed, rather than silently not.
CREATE TABLE email_preferences (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, category)
);

ALTER TABLE workspaces
  -- Set when a provider reports the address is permanently undeliverable.
  -- Continuing to send to a hard bounce is how a sending domain gets blocked,
  -- which then kills the alerts that actually matter.
  ADD COLUMN email_suppressed_at TIMESTAMPTZ,
  ADD COLUMN email_suppress_reason TEXT;
