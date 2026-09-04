/**
 * Capability gates, and the promise that nobody loses what they already have.
 *
 * Every plan limit before these was a number. These are the first gates on what
 * a plan can *do*, which makes two things worth proving rather than asserting:
 * that the gate actually refuses, and that it never refuses somebody who could
 * do it yesterday.
 *
 * The line the gates are drawn along is itself tested at the bottom: nothing
 * that keeps an agent from doing damage is behind one.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace, forgetPlanLimit } = await import('../../src/domain/auth.js');
const { PLANS } = await import('../../src/domain/plans.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

let n = 0;
async function workspace(plan: 'free' | 'pro' | 'scale', opts: { legacy?: boolean } = {}) {
  const label = `cap-${plan}-${n++}-${Date.now()}`;
  const ws = await createWorkspace(label, `${label}@example.test`, false);
  await getPool().query(
    'UPDATE workspaces SET plan = $2, legacy_capabilities = $3 WHERE id = $1',
    [ws.workspaceId, plan, opts.legacy ?? false]);
  forgetPlanLimit(ws.key.prefix);
  return ws;
}

/**
 * Every route a capability gate protects, described as a whole request.
 *
 * Each carries its own payload because Fastify validates the body BEFORE
 * preHandler runs: a POST with no body returns 400 and never reaches the gate,
 * so an empty request would test the schema and quietly prove nothing about
 * the capability.
 */
interface Probe { cap: string; url: string; method: 'GET' | 'POST'; payload?: unknown }

const GATED: Probe[] = [
  { cap: 'reversibleGroups', url: '/v1/groups', method: 'GET' },
  { cap: 'signedReceipts', url: '/v1/receipts/audit', method: 'GET' },
  { cap: 'reconciliation', url: '/v1/reconcile', method: 'POST',
    payload: { effect_type: 'email.send', keys: ['probe-key'] } },
  // The schedule reads the records the comparison writes, so the same capability
  // gates it: a plan that cannot reconcile has no calendar to keep.
  { cap: 'reconciliation', url: '/v1/reconcile/status', method: 'GET' },
];

const send = (key: string, probe: Probe) =>
  app.inject({
    method: probe.method, url: probe.url,
    headers: { authorization: `Bearer ${key}` },
    payload: probe.payload as never,
  });

const get = (key: string, url: string) =>
  send(key, { cap: '', url, method: 'GET' });

describe('capability gates actually refuse', () => {
  for (const probe of GATED) {
    test(`free is refused ${probe.url}`, async () => {
      const ws = await workspace('free');
      const r = await send(ws.key.plaintext, probe);
      assert.equal(r.statusCode, 403,
        `${probe.url} should be forbidden on free, got ${r.statusCode}`);
      const body = JSON.parse(r.payload);
      assert.equal(body.error.code, 'forbidden');
      // The message must name the thing and the plan that has it, or the reader
      // has to go and look up what they bought.
      assert.match(body.error.message, /plan does not include/);
      assert.match(body.error.message, /available on (Pro|Scale)/,
        `${probe.cap}: the refusal should say where it is available`);
    });
  }

  test('Pro gets groups and receipts, and is still refused reconciliation', async () => {
    const ws = await workspace('pro');
    assert.notEqual((await get(ws.key.plaintext, '/v1/groups')).statusCode, 403);
    assert.notEqual((await get(ws.key.plaintext, '/v1/receipts/audit')).statusCode, 403);
    const recon = GATED.find((p) => p.cap === 'reconciliation')!;
    assert.equal((await send(ws.key.plaintext, recon)).statusCode, 403,
      'reconciliation is a Scale capability');
  });

  test('Scale gets all three', async () => {
    const ws = await workspace('scale');
    for (const probe of GATED) {
      assert.notEqual((await send(ws.key.plaintext, probe)).statusCode, 403, probe.url);
    }
  });
});

describe('nobody is demoted', () => {
  /**
   * The whole point of migration 029. Every workspace that existed when gating
   * shipped keeps what it could already do — this codebase came one backfill
   * away from silently dropping every customer from 1,000 effects to 100, and
   * the same mistake is available here.
   */
  test('a workspace that predates gating keeps everything, on the free plan', async () => {
    const ws = await workspace('free', { legacy: true });
    for (const probe of GATED) {
      assert.notEqual((await send(ws.key.plaintext, probe)).statusCode, 403,
        `${probe.url} was taken away from a workspace that already had it`);
    }
  });

  /**
   * The column defaults to false, so signing up today lands you on your plan's
   * real capabilities. Only migration 029's one-time backfill sets it, and only
   * for rows that already existed.
   */
  test('signing up today does not grandfather you', async () => {
    const ws = await createWorkspace(`fresh-${Date.now()}`, `fresh-${Date.now()}@example.test`, false);
    const { rows } = await getPool().query<{ legacy_capabilities: boolean }>(
      'SELECT legacy_capabilities FROM workspaces WHERE id = $1', [ws.workspaceId]);
    assert.equal(rows[0]!.legacy_capabilities, false,
      'a new workspace must get its plan\'s capabilities, not the legacy grant');
  });
});

describe('the line the gates are drawn along', () => {
  /**
   * If this ever fails, someone has put safety behind a paywall. Every one of
   * these prevents an agent doing damage, and every one of them is free.
   */
  test('nothing that prevents damage is gated', () => {
    const free = PLANS.free;
    assert.equal(free.capabilities.reversibleGroups, false);
    // The safety surfaces are not capabilities at all — they have no flag to
    // turn off, which is the strongest form of "not for sale".
    const flags = Object.keys(free.capabilities);
    for (const forbidden of ['circuits', 'runBudget', 'recall', 'approvals', 'policies',
                             'indeterminate', 'atMostOnce', 'webhooks', 'audit']) {
      assert.equal(flags.includes(forbidden), false,
        `"${forbidden}" has become a plan capability — safety must not be sold by tier`);
    }
  });

  test('the free plan still does the thing the product is for', async () => {
    const ws = await workspace('free');
    // Surge containment, run budgets and recall are the safety net. All free.
    for (const url of ['/v1/circuits', '/v1/policies', '/v1/effects']) {
      const r = await get(ws.key.plaintext, url);
      assert.notEqual(r.statusCode, 403, `${url} must not be gated`);
    }
  });

  test('proving the value is free, because hiding it would be self-defeating', async () => {
    const ws = await workspace('free');
    const r = await get(ws.key.plaintext, '/v1/usage/prevented');
    assert.notEqual(r.statusCode, 403,
      'the report showing what Ratchet saved you is the reason to upgrade — '
      + 'putting it behind the upgrade is backwards');
  });
});

describe('the pricing table cannot drift from the gates', () => {
  /**
   * The table is rendered from what the API publishes, and the API reads the
   * same PLANS object the guards enforce. This proves the loop is closed: a
   * capability advertised on a tier is one that tier can actually use.
   */
  test('what /billing/plans advertises is what the code enforces', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/billing/plans' });
    assert.equal(r.statusCode, 200);
    const { plans } = JSON.parse(r.payload) as {
      plans: { id: keyof typeof PLANS; capabilities: Record<string, boolean> }[];
    };
    // Derived rather than a literal: adding a tier should not require editing
    // this test, only passing it. Every plan the code knows about must be
    // published, or a tier exists that nobody can see.
    assert.deepEqual(plans.map((p) => p.id).sort(), Object.keys(PLANS).sort());

    for (const published of plans) {
      const code = PLANS[published.id].capabilities;
      assert.deepEqual(published.capabilities, {
        reversible_groups: code.reversibleGroups,
        signed_receipts: code.signedReceipts,
        reconciliation: code.reconciliation,
      }, `${published.id}: the published capabilities disagree with the enforced ones`);
    }
  });

  test('the pricing page reads them rather than hard-coding a tier table', () => {
    const js = readFileSync(new URL('../../web/assets/pricing.js', import.meta.url), 'utf8');
    assert.match(js, /p\.capabilities\?\./,
      'the pricing page must render capabilities from the API, not a typed-out list');
    for (const key of ['reversible_groups', 'signed_receipts', 'reconciliation']) {
      assert.ok(js.includes(key), `the pricing page never mentions ${key}`);
    }
  });
});

/**
 * The gate must give the same answer to both credentials.
 *
 * requireCapability read req.auth, which requireKey sets and requireConsole
 * leaves unset on its cookie path. So the identical request refused with a
 * clean 403 for an API key and threw for a signed-in operator, arriving in the
 * console as "Internal error." on Rollbacks, receipts and reconciliation — the
 * seven routes that pair the two guards.
 *
 * A 500 is not a worse-worded 403. It says the fault is ours, it carries no
 * reason, and it tells somebody evaluating an upgrade that the feature is
 * broken rather than unavailable to them.
 */
describe('a capability gate answers the same whichever credential asked', () => {
  async function sessionFor(plan: 'free' | 'pro') {
    const ws = await workspace(plan);
    const email = `${ws.workspaceId}@example.test`;
    await getPool().query('UPDATE workspaces SET owner_email = $2 WHERE id = $1',
      [ws.workspaceId, email]);
    const { createConsoleSession } = await import('../../src/domain/auth.js');
    return { ws, cookie: `rk_session=${await createConsoleSession(ws.workspaceId, email)}` };
  }

  test('a free-plan cookie session is refused, not failed', async () => {
    const { cookie } = await sessionFor('free');
    const r = await app.inject({ method: 'GET', url: '/v1/groups?limit=5', headers: { cookie } });

    assert.notEqual(r.statusCode, 500, 'the gate threw instead of refusing');
    assert.equal(r.statusCode, 403);
    const body = JSON.parse(r.payload) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'forbidden');
    // The refusal has to say what would lift it, or it is just a closed door.
    assert.match(body.error.message, /does not include/);
    assert.match(body.error.message, /Pro/);
  });

  test('the key and the cookie agree, on both sides of the gate', async () => {
    for (const plan of ['free', 'pro'] as const) {
      const { ws, cookie } = await sessionFor(plan);
      const viaCookie = await app.inject({
        method: 'GET', url: '/v1/groups?limit=5', headers: { cookie },
      });
      const viaKey = await app.inject({
        method: 'GET', url: '/v1/groups?limit=5',
        headers: { authorization: `Bearer ${ws.key.plaintext}` },
      });
      assert.equal(viaCookie.statusCode, viaKey.statusCode,
        `${plan}: cookie got ${viaCookie.statusCode}, key got ${viaKey.statusCode}`);
      assert.equal(viaCookie.statusCode, plan === 'pro' ? 200 : 403);
    }
  });
});
