-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- An OAuth grant is backed by a real api_keys row.
--
-- Without this, an OAuth caller's key id fails the foreign key on
-- effects.leased_by_key_id, and every gated call from an MCP client over OAuth
-- dies with an internal error. Backing the grant with a key row also means the
-- existing machinery — per-key budgets, attribution in the audit trail, and
-- revocation from the console — works for OAuth clients with no special cases.
--
-- The key's plaintext is generated and immediately discarded: it is never
-- shown to anyone, and authentication always happens through the OAuth token.
ALTER TABLE oauth_tokens
  ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE CASCADE;

CREATE INDEX oauth_tokens_api_key ON oauth_tokens (api_key_id);
