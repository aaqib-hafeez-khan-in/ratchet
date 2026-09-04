import { randomUUID } from 'node:crypto';

// Tests run against a real Postgres. Configure BEFORE any module reads config.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet_test';
process.env.AUTH_SECRET ??= 'test-secret-that-is-long-enough-to-pass-checks';
process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK ??= 'true';
process.env.RATE_LIMIT_PER_MINUTE ??= '100000';
// Most suites exercise behaviour, not throttling. plan-limits.test.ts and
// limits.test.ts set this to '' first so they measure the real limits.
process.env.RATE_LIMIT_OVERRIDE ??= '100000';
// Keyless provisioning is now counted in Postgres rather than in memory, so the
// ceiling outlives the process: at the real limit of five an hour, any suite
// that provisions a sixth workspace would fail for the rest of the hour, and so
// would every later run. provisioning.test.ts sets these small on purpose.
process.env.PROVISION_PER_SOURCE_PER_HOUR ??= '100000';
process.env.PROVISION_GLOBAL_PER_HOUR ??= '100000';
process.env.LOG_LEVEL = 'silent';

// Neutralise payment configuration. dotenv does not override variables that are
// already set, so setting these first keeps the suite hermetic: it must behave
// identically whether or not the operator has real Stripe keys in their .env.
// A test that needs a different provider state sets it before importing this.
// Neutralise crypto configuration for the same reason as payments: the suite
// must behave identically whether or not the operator has real receiving
// addresses in their .env. A test that needs a chain enabled sets it first.
process.env.SOLANA_DESTINATION_ADDRESS ??= '';
process.env.ETHEREUM_DESTINATION_ADDRESS ??= '';
process.env.BITCOIN_DESTINATION_ADDRESS ??= '';

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
/**
 * A normal customer workspace: claimed, confirmed, on its plan.
 *
 * The address is marked confirmed here because that is what a real customer's
 * workspace looks like a minute after signing up, and almost every suite wants
 * to exercise something other than the confirmation step. The suites that DO
 * care — verification.test.ts — clear it explicitly, which is the right way
 * round: the unusual state is the one that gets set up on purpose.
 */
export async function freshWorkspace(seedPolicies = true) {
  await setupDb();
  const ws = await createWorkspace(`test-${randomUUID().slice(0, 8)}`,
    `t-${randomUUID().slice(0, 8)}@example.test`, seedPolicies);
  await getPool().query(
    'UPDATE workspaces SET email_verified_at = now() WHERE id = $1', [ws.workspaceId]);
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
