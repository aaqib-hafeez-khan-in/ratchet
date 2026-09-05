-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Second factor for operator actions taken through the console.
--
-- What this gates is deliberately narrow: the actions that can weaken
-- containment or move money — policy, keys, circuits, webhooks, billing — not
-- the act of opening the console. Reading is not the risk.
--
-- Why the secret is ENCRYPTED and not hashed, which departs from how API keys
-- are stored (CLAUDE.md §5.2): verifying a TOTP code requires recomputing the
-- HMAC, which requires the secret itself. A one-way hash cannot do that. So it
-- is sealed with AES-256-GCM under a key derived from AUTH_SECRET, and the
-- pepper's kid is stored beside it so rotation works exactly as it does for
-- keys: accept any configured pepper, re-seal onto the current one on use.
--
-- Recovery codes ARE hashed, because verifying one only needs a comparison.

ALTER TABLE workspaces
  -- {v1, kid, iv, tag, ciphertext} — see src/domain/mfa.ts
  ADD COLUMN mfa_secret        JSONB,
  ADD COLUMN mfa_enabled_at    TIMESTAMPTZ,
  -- Six digits is a million guesses. Without a limit that is a weekend's work,
  -- and the window never closes because a new code is always valid.
  ADD COLUMN mfa_failed        INT NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until  TIMESTAMPTZ;

-- Single-use, hashed like an API key. A recovery code is the credential that
-- survives losing the phone, so it is worth the same care.
CREATE TABLE mfa_recovery_codes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_hash     BYTEA NOT NULL,
  secret_kid    TEXT,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_workspace_idx ON mfa_recovery_codes (workspace_id)
  WHERE used_at IS NULL;

-- Step-up lives on the session, not on the workspace: verifying once should not
-- leave every future session elevated. Null means never verified.
ALTER TABLE console_sessions
  ADD COLUMN mfa_verified_at TIMESTAMPTZ;
