-- OAuth 2.1 + Dynamic Client Registration, for MCP clients and connector
-- directories that cannot ask a user to paste an API key.
--
-- Nothing here stores a bearer value in the clear. Codes and tokens are kept
-- as HMAC digests under AUTH_SECRET, exactly like api_keys, so a database leak
-- alone yields nothing usable.

-- Registered dynamically and without authentication, because the MCP spec
-- requires it. Registration therefore creates no access on its own: a client
-- row is inert until a human completes the authorization step.
CREATE TABLE oauth_clients (
  id             TEXT PRIMARY KEY,
  secret_hash    BYTEA,                     -- NULL for public (PKCE-only) clients
  name           TEXT NOT NULL,
  redirect_uris  TEXT[] NOT NULL,
  grant_types    TEXT[] NOT NULL DEFAULT ARRAY['authorization_code','refresh_token'],
  scopes         TEXT[] NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);

-- Short-lived, single-use, and bound to the client, the redirect URI, the PKCE
-- challenge, and the resource it was issued for.
CREATE TABLE oauth_codes (
  id             TEXT PRIMARY KEY,          -- sha256 of the code; the code itself is never stored
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,             -- S256 only; "plain" is refused at the endpoint
  scopes         TEXT[] NOT NULL,
  resource       TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_codes_expiry ON oauth_codes (expires_at);

CREATE TABLE oauth_tokens (
  id             TEXT PRIMARY KEY,
  prefix         TEXT NOT NULL UNIQUE,
  secret_hash    BYTEA NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes         TEXT[] NOT NULL,
  -- The audience. A token minted for one resource must not be accepted at
  -- another; this is what stops a token from being replayed at a different
  -- server by a client that was handed it in confidence.
  resource       TEXT,
  -- Which authorization code minted it. If that code is ever replayed, every
  -- token descended from it is revoked, per OAuth 2.1.
  code_id        TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_code ON oauth_tokens (code_id);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens (expires_at);
CREATE INDEX oauth_tokens_workspace ON oauth_tokens (workspace_id);
