import { randomUUID } from 'node:crypto';

// Tests run against a real Postgres. Configure BEFORE any module reads config.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet_test';
process.env.AUTH_SECRET ??= 'test-secret-that-is-long-enough-to-pass-checks';
process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK ??= 'true';
process.env.RATE_LIMIT_PER_MINUTE ??= '100000';
process.env.LOG_LEVEL = 'silent';

// Neutralise payment configuration. dotenv does not override variables that are
// already set, so setting these first keeps the suite hermetic: it must behave
// identically whether or not the operator has real Stripe keys in their .env.
// A test that needs a different provider state sets it before importing this.
process.env.BILLING_PROVIDER ??= 'test';
process.env.STRIPE_SECRET_KEY ??= '';
process.env.STRIPE_WEBHOOK_SECRET ??= '';

const { migrate } = await import('../src/db/migrate.js');
const { getPool, closePool } = await import('../src/db/pool.js');
const { createWorkspace, createApiKey, SCOPES } = await import('../src/domain/auth.js');

export { getPool, closePool };

let ready = false;
export async function setupDb(): Promise<void> {
  if (ready) return;
  await migrate(() => {});
  ready = true;
}

/** Isolated workspace per test, so tests never interfere with one another. */
export async function freshWorkspace(seedPolicies = true) {
  await setupDb();
  const ws = await createWorkspace(`test-${randomUUID().slice(0, 8)}`,
    `t-${randomUUID().slice(0, 8)}@example.test`, seedPolicies);
  return ws;
}

export async function keyWithScopes(workspaceId: string, scopes: string[]) {
  return createApiKey(getPool(), workspaceId, 'scoped', scopes as never[], null);
}

export const ALL_SCOPES = SCOPES;

export async function setBalance(workspaceId: string, micros: number) {
  await getPool().query('UPDATE workspaces SET credit_micros = $2 WHERE id = $1',
    [workspaceId, micros]);
}

export async function setPeriodDecisions(workspaceId: string, n: number) {
  await getPool().query('UPDATE workspaces SET period_decisions = $2 WHERE id = $1',
    [workspaceId, n]);
}

export async function expireLease(effectId: string) {
  await getPool().query(
    `UPDATE effects SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [effectId]);
}

export async function setPlan(workspaceId: string, plan: string) {
  await getPool().query('UPDATE workspaces SET plan = $2 WHERE id = $1', [workspaceId, plan]);
}
