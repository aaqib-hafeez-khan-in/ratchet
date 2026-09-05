// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { randomBytes, createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTx, type Db } from '../db/pool.js';
import { newId, sha256, constantTimeEqual } from '../lib/ids.js';
import { config } from '../lib/config.js';
import { errors } from '../lib/errors.js';
import { planFor } from './plans.js';

export const SCOPES = [
  'effects:begin',   // request permission to perform a side effect
  'effects:report',  // close out a leased effect
  'effects:read',    // read effect records and results
  'effects:admin',   // resolve, cancel, approve
  'policies:read',
  'policies:write',
  'workspace:read',  // plan, balance, usage
] as const;
export type Scope = (typeof SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: Scope[] = ['effects:begin', 'effects:report', 'effects:read'];

export function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}

/**
 * Key format: rk_<env>_<prefix>_<secret>
 *   prefix : 12 chars, stored in the clear, indexed — the lookup handle.
 *   secret : 32 chars, never stored. We keep HMAC-SHA256(secret, AUTH_SECRET),
 *            so a database leak alone does not yield usable keys.
 */
const KEY_RE = /^rk_(live|test)_([a-z0-9]{12})_([A-Za-z0-9_-]{32,})$/;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Every pepper this deployment will accept, current first.
 *
 * Read from config, which is resolved once at module load. Changing the set
 * therefore means a restart — which is exactly what rotating a secret is, and
 * why the tests for this spawn real processes rather than re-importing modules.
 */
function peppers(): string[] {
  return [config.authSecret, ...config.retiredAuthSecrets];
}

/**
 * A stable name for a pepper, without revealing it.
 *
 * Domain-separated so this can never collide with anything else derived from
 * the same secret, and truncated because it only has to distinguish two or
 * three values from each other.
 */
export function kidFor(pepper: string): string {
  return createHmac('sha256', pepper).update('ratchet-pepper-kid-v1').digest('hex').slice(0, 16);
}

function hashSecretWith(pepper: string, secret: string): Buffer {
  return createHmac('sha256', pepper).update(secret).digest();
}

function hashSecret(secret: string): Buffer {
  return hashSecretWith(config.authSecret, secret);
}

/**
 * Verify against every configured pepper and report which one matched.
 *
 * No early exit. Every pepper is tried and every comparison runs even once one
 * has matched, so the work — and therefore the timing — does not depend on
 * which secret a key belongs to, or on whether the prefix exists at all.
 */
function verifyAgainstAny(secret: string, stored: Buffer): { ok: boolean; pepper: string | null } {
  let matched: string | null = null;
  for (const pepper of peppers()) {
    const hit = constantTimeEqual(hashSecretWith(pepper, secret), stored);
    if (hit && matched === null) matched = pepper;
  }
  return { ok: matched !== null, pepper: matched };
}

export interface CreatedKey { id: string; prefix: string; plaintext: string; }

export async function createApiKey(
  db: Db, workspaceId: string, name: string,
  scopes: Scope[] = DEFAULT_AGENT_SCOPES,
  dailyBudgetMicros: number | null = null,
): Promise<CreatedKey> {
  const prefix = b64url(randomBytes(9)).toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12).padEnd(12, '0');
  const secret = b64url(randomBytes(24));
  const env = config.isProd ? 'live' : 'test';
  const plaintext = `rk_${env}_${prefix}_${secret}`;
  const id = newId('key');

  await db.query(
    `INSERT INTO api_keys
       (id, workspace_id, name, prefix, secret_hash, secret_kid, scopes, daily_budget_micros)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, workspaceId, name, prefix, hashSecret(secret), kidFor(config.authSecret),
     scopes, dailyBudgetMicros],
  );
  return { id, prefix, plaintext };
}

/**
 * Per-key rate limit cache.
 *
 * The rate limiter runs as an onRequest hook before any route guard, so it
 * cannot wait on a database lookup without putting a query in front of every
 * request. Successful authentications publish the key's plan limit here, and
 * the limiter reads it synchronously. A cold or expired entry falls back to the
 * free-plan limit, so an unknown key is under-served rather than over-served.
 */
const planLimitCache = new Map<string, { limit: number; at: number }>();
const PLAN_CACHE_TTL_MS = 60_000;

export function cachedPlanLimit(prefix: string): number | null {
  const hit = planLimitCache.get(prefix);
  if (!hit || Date.now() - hit.at > PLAN_CACHE_TTL_MS) return null;
  return hit.limit;
}

/** Drops a key's cached limit, so a plan change takes effect immediately. */
export function forgetPlanLimit(prefix: string): void {
  planLimitCache.delete(prefix);
}

export interface AuthContext {
  workspaceId: string;
  keyId: string;
  keyPrefix: string;
  scopes: Scope[];
  keyDailyBudgetMicros: number | null;
  plan: ReturnType<typeof planFor>;
  workspaceStatus: 'active' | 'suspended';
  /**
   * True for every workspace that existed before capability gating (migration
   * 029). Such a workspace keeps what it could already do, whatever its plan
   * says, because taking a working feature away from somebody already using it
   * is a demotion — the mistake email verification came within one backfill of
   * making. Never set on a new workspace.
   */
  legacyCapabilities: boolean;
}

/**
 * How far a rotation has drained.
 *
 * A rotation is not finished when the new secret is deployed; it is finished
 * when nothing still authenticates with the old one. Without this an operator
 * keeps a retired secret for ever, because dropping it is a guess. Revoked keys
 * are excluded — they can never authenticate again and cannot hold a rotation open.
 */
export async function pepperDrain(db: Db = getPool()): Promise<{
  currentKid: string;
  live: { kid: string | null; keys: number; current: boolean; known: boolean }[];
}> {
  const currentKid = kidFor(config.authSecret);
  const known = new Set(peppers().map(kidFor));
  const { rows } = await db.query<{ secret_kid: string | null; n: string }>(
    `SELECT secret_kid, count(*) AS n
       FROM api_keys WHERE revoked_at IS NULL
      GROUP BY secret_kid ORDER BY count(*) DESC`,
  );
  return {
    currentKid,
    live: rows.map((r) => ({
      kid: r.secret_kid,
      keys: Number(r.n),
      current: r.secret_kid === currentKid,
      // A null kid predates the column and is verified against every pepper;
      // an unrecognised one belongs to a secret no longer configured, which
      // means those keys can no longer authenticate at all.
      known: r.secret_kid === null || known.has(r.secret_kid),
    })),
  };
}

export async function authenticate(token: string): Promise<AuthContext> {
  const m = KEY_RE.exec(token.trim());
  if (!m) throw errors.unauthorized();
  const [, , prefix, secret] = m;

  const { rows } = await getPool().query<{
    id: string; workspace_id: string; secret_hash: Buffer; secret_kid: string | null;
    scopes: string[];
    daily_budget_micros: number | null; revoked_at: Date | null;
    plan: string; status: 'active' | 'suspended'; legacy_capabilities: boolean;
  }>(
    `SELECT k.id, k.workspace_id, k.secret_hash, k.secret_kid, k.scopes,
            k.daily_budget_micros,
            k.revoked_at, w.plan, w.status, w.legacy_capabilities
       FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.prefix = $1`,
    [prefix],
  );
  const row = rows[0];

  // Always run the comparison, even for an unknown prefix, so timing does not
  // reveal whether a prefix exists — and against every configured pepper, so it
  // does not reveal which secret a key belongs to either.
  const stored = row?.secret_hash ?? Buffer.alloc(32);
  const { ok: match, pepper } = verifyAgainstAny(secret!, stored);

  if (!row || !match || row.revoked_at) throw errors.unauthorized();

  /**
   * Drain the key onto the current pepper, once, the first time it is used.
   *
   * This is what makes a rotation finishable rather than merely survivable: the
   * fleet moves across as it is used, and the retired secret can eventually be
   * dropped instead of being kept for ever because nobody knows what still
   * depends on it. Best-effort and out of band — a key that authenticated
   * correctly must not be refused because a bookkeeping write failed.
   */
  const currentKid = kidFor(config.authSecret);
  if (pepper !== config.authSecret || row.secret_kid !== currentKid) {
    const rehashed = hashSecret(secret!);
    void getPool().query(
      'UPDATE api_keys SET secret_hash = $2, secret_kid = $3 WHERE id = $1',
      [row.id, rehashed, currentKid],
    ).catch(() => {});
  }
  if (row.status === 'suspended') {
    throw errors.forbidden('This workspace is suspended.');
  }

  planLimitCache.set(prefix!, { limit: planFor(row.plan).rateLimitPerMinute, at: Date.now() });

  // Best-effort usage stamp, coarsened to once a minute. Writing on every
  // request would take an exclusive row lock that contends with the KEY SHARE
  // lock in-flight begins hold on the same key, for no extra information.
  void getPool()
    .query(
      `UPDATE api_keys SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.id])
    .catch(() => {});

  return {
    workspaceId: row.workspace_id,
    keyId: row.id,
    keyPrefix: prefix!,
    scopes: row.scopes.filter(isScope),
    keyDailyBudgetMicros: row.daily_budget_micros,
    plan: planFor(row.plan),
    workspaceStatus: row.status,
    legacyCapabilities: row.legacy_capabilities,
  };
}

export function requireScope(ctx: AuthContext, scope: Scope): void {
  if (!ctx.scopes.includes(scope)) {
    throw errors.forbidden(
      `This key is missing the "${scope}" scope.`,
      { required: scope, granted: ctx.scopes },
    );
  }
}

export async function listApiKeys(db: Db, workspaceId: string) {
  const { rows } = await db.query(
    `SELECT id, name, prefix, scopes, daily_budget_micros, last_used_at, revoked_at, created_at
       FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes,
    dailyBudgetMicros: r.daily_budget_micros,
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    revoked: r.revoked_at !== null,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function revokeApiKey(db: Db, workspaceId: string, keyId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [keyId, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------------ workspace

export interface NewWorkspace {
  workspaceId: string; name: string; email: string | null; key: CreatedKey;
}

/**
 * Self-serve onboarding: one call creates the workspace, seeds sensible
 * starter policies, and returns the first scoped key. This is the entire
 * signup flow — an agent operator can be integrated in a single request.
 */
export async function createWorkspace(
  name: string, email: string | null, seedPolicies = true,
  anonymous = false,
): Promise<NewWorkspace> {
  return withTx(async (tx: PoolClient) => {
    const id = newId('ws');
    await tx.query(
      `INSERT INTO workspaces (id, name, owner_email, plan, anonymous)
       VALUES ($1,$2,$3,'free',$4)`,
      [id, name, email ? email.toLowerCase() : null, anonymous],
    );
    if (seedPolicies) {
      // Illustrative defaults that demonstrate each on_indeterminate mode.
      const seeds: Array<[string, string, string, number]> = [
        ['email.send', 'allow', 'block', 120],
        ['payment.charge', 'allow', 'probe', 90],
        ['http.post', 'allow', 'retry', 60],
      ];
      for (const [type, mode, onInd, lease] of seeds) {
        await tx.query(
          `INSERT INTO effect_policies
             (workspace_id, effect_type, mode, on_indeterminate, lease_seconds)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id, type, mode, onInd, lease],
        );
      }
    }
    const key = await createApiKey(tx, id, 'default', [...SCOPES], null);
    await tx.query(
      `INSERT INTO workspace_milestones (workspace_id, milestone) VALUES ($1,'workspace_created')
       ON CONFLICT DO NOTHING`, [id]);
    await tx.query(
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,'workspace.created',$2,$3,$4)`,
      [id, email ? `console:${email.toLowerCase()}` : 'anonymous',
       id, JSON.stringify({ name, anonymous })],
    );
    return { workspaceId: id, name, email: email ? email.toLowerCase() : null, key };
  });
}

export async function getWorkspace(db: Db, workspaceId: string) {
  const { rows } = await db.query(
    `SELECT id, name, owner_email, plan, credit_micros, period_start,
            period_decisions, status, created_at
       FROM workspaces WHERE id = $1`, [workspaceId],
  );
  const r = rows[0];
  if (!r) return null;
  const plan = planFor(r.plan);
  return {
    workspaceId: r.id, name: r.name, ownerEmail: r.owner_email,
    plan: {
      id: plan.id, name: plan.name,
      includedEffects: plan.includedEffects,
      overageMicrosPerEffect: plan.overageMicrosPerEffect,
      rateLimitPerMinute: plan.rateLimitPerMinute,
      maxRetentionDays: plan.maxRetentionDays,
    },
    creditMicros: r.credit_micros,
    usage: {
      periodStart: r.period_start.toISOString(),
      effectsThisPeriod: r.period_decisions,
      includedRemaining: Math.max(0, plan.includedEffects - r.period_decisions),
    },
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

// ------------------------------------------------------------ console session

export async function createConsoleSession(
  workspaceId: string, email: string,
): Promise<string> {
  const raw = b64url(randomBytes(32));
  const id = sha256(raw + config.authSecret).toString('hex');
  const expires = new Date(Date.now() + config.consoleSessionTtlHours * 3_600_000);
  await getPool().query(
    `INSERT INTO console_sessions (id, workspace_id, email, expires_at) VALUES ($1,$2,$3,$4)`,
    [id, workspaceId, email, expires],
  );
  return raw;
}

export interface ConsoleSession {
  workspaceId: string;
  email: string;
  /** The stored session id — the hash of the cookie, never the cookie itself.
   *  Step-up verification is recorded against this row, not the workspace. */
  sessionId: string;
  plan: ReturnType<typeof planFor>;
  /** Same grandfathering rule as an API key context: see migration 029. */
  legacyCapabilities: boolean;
}

export async function resolveConsoleSession(
  raw: string,
): Promise<ConsoleSession | null> {
  const id = sha256(raw + config.authSecret).toString('hex');
  // The plan travels with the session on purpose. A capability check asks "may
  // this workspace do this", and the answer cannot depend on which credential
  // asked — a cookie session that carried no plan made every capability-gated
  // route throw instead of answering, which surfaced as a 500.
  const { rows } = await getPool().query<{
    workspace_id: string; email: string; plan: string; legacy_capabilities: boolean;
  }>(
    `SELECT s.workspace_id, s.email, w.plan, w.legacy_capabilities
       FROM console_sessions s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1 AND s.expires_at > now()`, [id],
  );
  const r = rows[0];
  return r
    ? {
      workspaceId: r.workspace_id,
      email: r.email,
      sessionId: id,
      plan: planFor(r.plan),
      legacyCapabilities: r.legacy_capabilities,
    }
    : null;
}

/**
 * Provision a workspace for a caller that has no key yet.
 *
 * Deliberately small. An anonymous workspace can prove the gate works and
 * nothing more; the quota below is enforced in metering, and claiming it with
 * an email lifts it to the normal free plan. Keeping it small is what makes an
 * unauthenticated write acceptable at all.
 */
export const ANONYMOUS_EFFECT_QUOTA = 100;

export async function provisionAnonymousWorkspace(): Promise<NewWorkspace> {
  return createWorkspace('Unclaimed workspace', null, true, true);
}

/**
 * Attach an owner to an anonymous workspace.
 *
 * Only ever moves a workspace from unowned to owned. A workspace that already
 * has an owner is refused, so this can never be used to take one over.
 */
export async function claimWorkspace(
  workspaceId: string, email: string,
): Promise<{ claimed: boolean; reason?: string }> {
  const { rowCount } = await getPool().query(
    `UPDATE workspaces
        SET owner_email = $2, anonymous = false, claimed_at = now()
      WHERE id = $1 AND anonymous = true AND claimed_at IS NULL`,
    [workspaceId, email.toLowerCase()],
  );
  if (rowCount === 1) return { claimed: true };
  return { claimed: false, reason: 'This workspace is not an unclaimed anonymous workspace.' };
}

export interface WorkspaceChoice {
  id: string; name: string; plan: string; status: 'active' | 'suspended';
}

/**
 * Every workspace owned by an email address.
 *
 * `owner_email` is indexed but deliberately not unique — one person may run a
 * staging workspace and a production one — so an authorization flow has to ask
 * which of them the client is being let into rather than assume.
 */
export async function listWorkspacesForEmail(email: string): Promise<WorkspaceChoice[]> {
  const { rows } = await getPool().query<WorkspaceChoice>(
    `SELECT id, name, plan, status FROM workspaces
      WHERE lower(owner_email) = lower($1)
      ORDER BY created_at ASC`, [email]);
  return rows;
}

/**
 * Authorise a workspace choice against the signed-in identity.
 *
 * The workspace id arrives from a form field, so it is caller-supplied and
 * cannot be trusted. Returning null for anything the email does not own is what
 * stops a session for one workspace from minting a token for another.
 */
export async function workspaceOwnedBy(
  email: string, workspaceId: string,
): Promise<WorkspaceChoice | null> {
  const { rows } = await getPool().query<WorkspaceChoice>(
    `SELECT id, name, plan, status FROM workspaces
      WHERE id = $1 AND lower(owner_email) = lower($2)`, [workspaceId, email]);
  return rows[0] ?? null;
}

/** The owning email for a workspace, used to give an OAuth session a real identity. */
export async function ownerEmailOf(workspaceId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ owner_email: string }>(
    `SELECT owner_email FROM workspaces WHERE id = $1`, [workspaceId]);
  return rows[0]?.owner_email ?? null;
}

export async function destroyConsoleSession(raw: string): Promise<void> {
  const id = sha256(raw + config.authSecret).toString('hex');
  await getPool().query('DELETE FROM console_sessions WHERE id = $1', [id]);
}
