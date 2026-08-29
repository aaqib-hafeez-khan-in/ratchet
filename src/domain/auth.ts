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

function hashSecret(secret: string): Buffer {
  return createHmac('sha256', config.authSecret).update(secret).digest();
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
    `INSERT INTO api_keys (id, workspace_id, name, prefix, secret_hash, scopes, daily_budget_micros)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, workspaceId, name, prefix, hashSecret(secret), scopes, dailyBudgetMicros],
  );
  return { id, prefix, plaintext };
}

export interface AuthContext {
  workspaceId: string;
  keyId: string;
  keyPrefix: string;
  scopes: Scope[];
  keyDailyBudgetMicros: number | null;
  plan: ReturnType<typeof planFor>;
  workspaceStatus: 'active' | 'suspended';
}

export async function authenticate(token: string): Promise<AuthContext> {
  const m = KEY_RE.exec(token.trim());
  if (!m) throw errors.unauthorized();
  const [, , prefix, secret] = m;

  const { rows } = await getPool().query<{
    id: string; workspace_id: string; secret_hash: Buffer; scopes: string[];
    daily_budget_micros: number | null; revoked_at: Date | null;
    plan: string; status: 'active' | 'suspended';
  }>(
    `SELECT k.id, k.workspace_id, k.secret_hash, k.scopes, k.daily_budget_micros,
            k.revoked_at, w.plan, w.status
       FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.prefix = $1`,
    [prefix],
  );
  const row = rows[0];

  // Always run the comparison, even for an unknown prefix, so timing does not
  // reveal whether a prefix exists.
  const candidate = hashSecret(secret!);
  const stored = row?.secret_hash ?? Buffer.alloc(32);
  const match = constantTimeEqual(candidate, stored);

  if (!row || !match || row.revoked_at) throw errors.unauthorized();
  if (row.status === 'suspended') {
    throw errors.forbidden('This workspace is suspended.');
  }

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
  workspaceId: string; name: string; email: string; key: CreatedKey;
}

/**
 * Self-serve onboarding: one call creates the workspace, seeds sensible
 * starter policies, and returns the first scoped key. This is the entire
 * signup flow — an agent operator can be integrated in a single request.
 */
export async function createWorkspace(
  name: string, email: string, seedPolicies = true,
): Promise<NewWorkspace> {
  return withTx(async (tx: PoolClient) => {
    const id = newId('ws');
    await tx.query(
      `INSERT INTO workspaces (id, name, owner_email, plan) VALUES ($1,$2,$3,'free')`,
      [id, name, email.toLowerCase()],
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
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,'workspace.created',$2,$3,$4)`,
      [id, `console:${email.toLowerCase()}`, id, JSON.stringify({ name })],
    );
    return { workspaceId: id, name, email: email.toLowerCase(), key };
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

export async function resolveConsoleSession(
  raw: string,
): Promise<{ workspaceId: string; email: string } | null> {
  const id = sha256(raw + config.authSecret).toString('hex');
  const { rows } = await getPool().query<{ workspace_id: string; email: string }>(
    `SELECT workspace_id, email FROM console_sessions
      WHERE id = $1 AND expires_at > now()`, [id],
  );
  const r = rows[0];
  return r ? { workspaceId: r.workspace_id, email: r.email } : null;
}

export async function destroyConsoleSession(raw: string): Promise<void> {
  const id = sha256(raw + config.authSecret).toString('hex');
  await getPool().query('DELETE FROM console_sessions WHERE id = $1', [id]);
}
