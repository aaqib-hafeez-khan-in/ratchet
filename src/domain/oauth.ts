// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * OAuth 2.1 with PKCE and Dynamic Client Registration.
 *
 * This exists so an MCP client or a connector directory can obtain access
 * without a human copying an API key into a config file. It is deliberately
 * narrow: authorization code with PKCE, and refresh. No implicit grant, no
 * password grant, no "plain" challenge method — all three are removed in
 * OAuth 2.1 precisely because they are the ones that get exploited.
 *
 * Two properties matter most here and are enforced rather than assumed:
 *
 *   Audience binding. A token records the resource it was minted for and is
 *   rejected anywhere else. Without this, a client that holds a token for one
 *   server can replay it against another that trusts the same issuer — the
 *   confused deputy the MCP spec calls out by name.
 *
 *   Single-use codes. Replaying an authorization code revokes every token
 *   descended from it, rather than merely failing. A replay means the code
 *   leaked, and the tokens it produced can no longer be trusted.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { config } from '../lib/config.js';
import { newId } from '../lib/ids.js';
import { planFor } from './plans.js';
import { isScope, createApiKey, type Scope, type AuthContext } from './auth.js';

const ACCESS_TTL_SECONDS = 60 * 60;            // 1 hour
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL_SECONDS = 60;                   // one minute is ample for a redirect

/** Access and refresh tokens. `oat`/`ort` cannot collide with an `rk_live_` API key. */
const TOKEN_RE = /^rk_(oat|ort)_([a-z0-9]{12})_([A-Za-z0-9_-]{32,})$/;

const hashSecret = (s: string): Buffer =>
  createHmac('sha256', config.authSecret).update(s).digest();

const sha256hex = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────── redirect URIs

/**
 * A redirect URI is the one place an attacker can turn this server into an
 * open redirect, so the rules are strict and the match is exact.
 *
 * Loopback HTTP is permitted because RFC 8252 requires it for native apps —
 * which is what most MCP clients are. Everything else must be HTTPS, and no
 * URI may carry a fragment.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    return u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === 'localhost';
  }
  // A private-use scheme (com.example.app:/callback) is how native apps
  // register. Permitted, but it must actually be one — not javascript: or data:.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol)
    && !['javascript:', 'data:', 'file:', 'vbscript:'].includes(u.protocol);
}

// ─────────────────────────────────────────────────────── client registration

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  name: string;
  redirectUris: string[];
  scopes: Scope[];
}

export async function registerClient(input: {
  name: string; redirectUris: string[]; scopes: Scope[]; confidential: boolean;
}): Promise<RegisteredClient> {
  const clientId = newId('oc');
  const secret = input.confidential ? randomBytes(32).toString('base64url') : undefined;

  await getPool().query(
    `INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, scopes)
     VALUES ($1, $2, $3, $4, $5)`,
    [clientId, secret ? hashSecret(secret) : null, input.name,
     input.redirectUris, input.scopes],
  );

  return { clientId, ...(secret ? { clientSecret: secret } : {}),
           name: input.name, redirectUris: input.redirectUris, scopes: input.scopes };
}

export interface ClientRow {
  id: string; name: string; redirectUris: string[]; scopes: Scope[];
  secretHash: Buffer | null;
}

export async function findClient(clientId: string): Promise<ClientRow | null> {
  const { rows } = await getPool().query<{
    id: string; name: string; redirect_uris: string[];
    scopes: string[]; secret_hash: Buffer | null;
  }>(`SELECT id, name, redirect_uris, scopes, secret_hash FROM oauth_clients WHERE id = $1`,
     [clientId]);
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, name: r.name, redirectUris: r.redirect_uris,
           scopes: r.scopes.filter(isScope), secretHash: r.secret_hash };
}

/** Confidential clients authenticate at the token endpoint; public ones rely on PKCE. */
export function clientSecretMatches(client: ClientRow, presented: string | undefined): boolean {
  if (!client.secretHash) return true;              // public client
  if (!presented) return false;
  return constantTimeEqual(hashSecret(presented), client.secretHash);
}

// ─────────────────────────────────────────────────────── authorization codes

export async function issueCode(input: {
  clientId: string; workspaceId: string; redirectUri: string;
  codeChallenge: string; scopes: Scope[]; resource: string | null;
}): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await getPool().query(
    `INSERT INTO oauth_codes
       (id, client_id, workspace_id, redirect_uri, code_challenge, scopes, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))`,
    [sha256hex(code), input.clientId, input.workspaceId, input.redirectUri,
     input.codeChallenge, input.scopes, input.resource, CODE_TTL_SECONDS],
  );
  return code;
}

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Redeem a code exactly once.
 *
 * The consume is an UPDATE guarded on `consumed_at IS NULL`, so two concurrent
 * redemptions cannot both win — the database decides, not a read-then-write in
 * application code.
 */
export async function redeemCode(input: {
  code: string; clientId: string; redirectUri: string; codeVerifier: string;
  resource: string | null;
}): Promise<{ workspaceId: string; scopes: Scope[]; codeId: string; resource: string | null }> {
  const id = sha256hex(input.code);
  const pool = getPool();

  const { rows } = await pool.query<{
    client_id: string; workspace_id: string; redirect_uri: string;
    code_challenge: string; scopes: string[]; resource: string | null;
    expired: boolean; consumed: boolean;
  }>(`SELECT client_id, workspace_id, redirect_uri, code_challenge, scopes, resource,
             expires_at <= now() AS expired, consumed_at IS NOT NULL AS consumed
        FROM oauth_codes WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new OAuthError('invalid_grant', 'Unknown or expired authorization code.');

  if (row.consumed) {
    // A replayed code means it leaked. Everything it produced is now suspect.
    await pool.query(
      `UPDATE oauth_tokens SET revoked_at = now()
        WHERE code_id = $1 AND revoked_at IS NULL`, [id]);
    throw new OAuthError('invalid_grant',
      'This authorization code was already used. All tokens issued from it have been revoked.');
  }
  if (row.expired) throw new OAuthError('invalid_grant', 'Authorization code has expired.');
  if (row.client_id !== input.clientId) {
    throw new OAuthError('invalid_grant', 'This code was issued to a different client.');
  }
  if (row.redirect_uri !== input.redirectUri) {
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
  }
  // The token must be for the resource the user consented to.
  if (input.resource && row.resource && input.resource !== row.resource) {
    throw new OAuthError('invalid_target', 'resource does not match the authorization request.');
  }

  // PKCE. S256 only — the challenge stored is base64url(sha256(verifier)).
  const computed = createHash('sha256').update(input.codeVerifier).digest('base64url');
  if (!constantTimeEqual(Buffer.from(computed), Buffer.from(row.code_challenge))) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed.');
  }

  const claimed = await pool.query(
    `UPDATE oauth_codes SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL`, [id]);
  if (claimed.rowCount !== 1) {
    throw new OAuthError('invalid_grant', 'This authorization code was already used.');
  }

  return { workspaceId: row.workspace_id, scopes: row.scopes.filter(isScope),
           codeId: id, resource: row.resource };
}

// ─────────────────────────────────────────────────────── tokens

export interface IssuedTokens {
  accessToken: string; refreshToken: string; expiresIn: number; scopes: Scope[];
}

export async function issueTokens(input: {
  clientId: string; workspaceId: string; scopes: Scope[];
  resource: string | null; codeId: string | null;
  /** Carried through a refresh so a grant keeps one identity for its whole life. */
  apiKeyId?: string;
}): Promise<IssuedTokens> {
  // A grant is backed by a real api_keys row, so everything downstream — the
  // foreign key on effects.leased_by_key_id, per-key budgets, attribution, and
  // revocation from the console — treats an OAuth client like any other caller.
  // The generated plaintext is discarded here and never shown to anyone.
  let apiKeyId = input.apiKeyId;
  if (!apiKeyId) {
    const client = await findClient(input.clientId);
    const created = await createApiKey(
      getPool(), input.workspaceId,
      `OAuth · ${client?.name ?? input.clientId}`.slice(0, 120),
      input.scopes, null);
    apiKeyId = created.id;
  }

  const mint = async (kind: 'access' | 'refresh', ttl: number) => {
    const prefix = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const token = `rk_${kind === 'access' ? 'oat' : 'ort'}_${prefix}_${secret}`;
    await getPool().query(
      `INSERT INTO oauth_tokens
         (id, prefix, secret_hash, kind, client_id, workspace_id, scopes, resource, code_id,
        api_key_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(secs => $11))`,
      [newId('otk'), prefix, hashSecret(secret), kind, input.clientId, input.workspaceId,
       input.scopes, input.resource, input.codeId, apiKeyId, ttl],
    );
    return token;
  };

  return {
    accessToken: await mint('access', ACCESS_TTL_SECONDS),
    refreshToken: await mint('refresh', REFRESH_TTL_SECONDS),
    expiresIn: ACCESS_TTL_SECONDS,
    scopes: input.scopes,
  };
}

interface TokenRow {
  id: string; kind: 'access' | 'refresh'; client_id: string; workspace_id: string;
  scopes: string[]; resource: string | null; code_id: string | null;
  api_key_id: string | null; key_prefix: string | null;
  key_budget_micros: number | null; key_revoked: boolean;
  expired: boolean; revoked: boolean; plan: string; status: 'active' | 'suspended'; legacy_capabilities: boolean;
}

async function lookupToken(token: string, kind: 'access' | 'refresh'): Promise<TokenRow | null> {
  const m = TOKEN_RE.exec(token.trim());
  if (!m) return null;
  const [, sort, prefix, secret] = m;
  if ((sort === 'oat' ? 'access' : 'refresh') !== kind) return null;

  const { rows } = await getPool().query<TokenRow & { secret_hash: Buffer }>(
    `SELECT t.id, t.kind, t.client_id, t.workspace_id, t.scopes, t.resource, t.code_id,
            t.secret_hash, t.api_key_id,
            t.expires_at <= now() AS expired, t.revoked_at IS NOT NULL AS revoked,
            k.prefix AS key_prefix, k.daily_budget_micros AS key_budget_micros,
            k.revoked_at IS NOT NULL AS key_revoked,
            w.plan, w.status, w.legacy_capabilities
       FROM oauth_tokens t
       JOIN workspaces w ON w.id = t.workspace_id
       LEFT JOIN api_keys k ON k.id = t.api_key_id
      WHERE t.prefix = $1 AND t.kind = $2`, [prefix, kind]);
  const row = rows[0];

  // Compare even when the prefix is unknown, so timing does not disclose it.
  const ok = constantTimeEqual(hashSecret(secret!), row?.secret_hash ?? Buffer.alloc(32));
  // Revoking the backing key from the console kills the grant too, which is
  // the only revocation surface an operator is likely to reach for.
  if (!row || !ok || row.revoked || row.expired || row.key_revoked) return null;
  return row;
}

/**
 * Resolve an access token to the same AuthContext an API key produces, so every
 * downstream route and guard is unchanged and cannot accidentally treat an
 * OAuth caller differently.
 */
export async function authenticateOAuth(
  token: string, expectedResource: string,
): Promise<AuthContext | null> {
  const row = await lookupToken(token, 'access');
  if (!row) return null;

  // Audience binding. A token minted for another resource is not valid here,
  // even though this server issued it.
  if (row.resource && row.resource !== expectedResource) return null;
  if (row.status === 'suspended') return null;

  return {
    workspaceId: row.workspace_id,
    // The backing key, so the foreign key on effects.leased_by_key_id holds and
    // the audit trail attributes the work to a revocable identity.
    keyId: row.api_key_id ?? row.id,
    keyPrefix: row.key_prefix ?? `oauth:${row.client_id}`,
    scopes: row.scopes.filter(isScope),
    keyDailyBudgetMicros: row.key_budget_micros,
    plan: planFor(row.plan),
    workspaceStatus: row.status,
    // An OAuth-authenticated agent is the same workspace as a key-authenticated
    // one. Reading this from a different place would let the two disagree about
    // what the workspace may do, which is the kind of split nobody finds until
    // a customer reports that one client works and the other does not.
    legacyCapabilities: row.legacy_capabilities,
  };
}

/** Refresh rotates: the presented refresh token is revoked as the new pair is minted. */
export async function refreshTokens(input: {
  refreshToken: string; clientId: string;
}): Promise<IssuedTokens> {
  const row = await lookupToken(input.refreshToken, 'refresh');
  if (!row) throw new OAuthError('invalid_grant', 'Unknown or expired refresh token.');
  if (row.client_id !== input.clientId) {
    throw new OAuthError('invalid_grant', 'This refresh token was issued to a different client.');
  }

  await getPool().query(
    `UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);

  return issueTokens({
    clientId: row.client_id, workspaceId: row.workspace_id,
    scopes: row.scopes.filter(isScope), resource: row.resource, codeId: row.code_id,
    apiKeyId: row.api_key_id ?? undefined,
  });
}

export async function revokeToken(token: string): Promise<void> {
  const m = TOKEN_RE.exec(token.trim());
  if (!m) return;                                    // RFC 7009: always 200
  const [, sort, prefix, secret] = m;
  const kind = sort === 'oat' ? 'access' : 'refresh';
  const { rows } = await getPool().query<{ id: string; secret_hash: Buffer }>(
    `SELECT id, secret_hash FROM oauth_tokens WHERE prefix = $1 AND kind = $2`, [prefix, kind]);
  const row = rows[0];
  if (row && constantTimeEqual(hashSecret(secret!), row.secret_hash)) {
    await getPool().query(`UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
  }
}
