// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The gate's cost, expressed as things it must not do.
 *
 * Latency assertions are flaky by nature — a loaded CI runner will fail a
 * "under 5ms" test that says nothing about the code. Round trips are not: they
 * are a property of the code, they are what the latency is actually made of,
 * and a regression shows up here as a number instead of as a slow afternoon.
 *
 * Each count below was reduced deliberately. If one goes up, something has
 * started asking the database a question it already had the answer to.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let key: string;

/** Queries seen while `watching`, matched against the SQL text. */
const seen: string[] = [];
let watching = false;

before(async () => {
  await setupDb();
  const pool = getPool() as unknown as {
    query: (...a: unknown[]) => unknown;
    connect: (...a: unknown[]) => unknown;
  };

  /**
   * Wrap the pool AND the clients it hands out.
   *
   * Watching only `pool.query` sees the queries issued outside a transaction
   * and none of the ones inside it — which silently turns every "this query
   * does not happen" assertion into a test that passes because it is looking
   * at an empty list. Two of these tests did exactly that before this was
   * fixed.
   */
  const watch = (target: { query: (...a: unknown[]) => unknown } & Record<string, unknown>) => {
    if (target.__watched) return;
    target.__watched = true;
    const orig = target.query.bind(target);
    target.query = (...a: unknown[]) => {
      const sql = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string })?.text ?? '';
      if (watching) seen.push(sql.replace(/\s+/g, ' '));
      return orig(...a);
    };
  };
  // Watch ONLY the clients. `pool.query()` in pg checks out a client and calls
  // client.query, so wrapping both levels counts every pooled query twice —
  // which reads exactly like a duplicate query in the code and sent me looking
  // for a bug that was in the measurement.
  const origConnect = pool.connect.bind(pool);
  pool.connect = (...a: unknown[]) => {
    if (typeof a[0] === 'function') return origConnect(...a);   // callback form
    return (origConnect(...a) as Promise<never>).then((client: never) => {
      if (client && (client as { query?: unknown }).query) watch(client);
      return client;
    });
  };

  app = await buildApp({ logger: false });
  await app.ready();
  const ws = JSON.parse((await app.inject({
    method: 'POST', url: '/v1/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: { name: 'hot', email: `hot-${Date.now()}@example.test` },
  })).payload);
  key = ws.api_key?.plaintext ?? ws.api_key;
});
after(async () => { await app.close(); await closePool(); });

const begin = (idem: string) => app.inject({
  method: 'POST', url: '/v1/effects/begin',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: { effect_type: 'hot.probe', idempotency_key: idem, payload: { a: 1 } },
});

/** Run one request and report only the queries it issued. */
async function queriesFor(fn: () => Promise<unknown>): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 250));   // let fire-and-forget writes drain
  seen.length = 0;
  watching = true;
  await fn();
  await new Promise((r) => setTimeout(r, 150));
  watching = false;
  return [...seen];
}

describe('what one begin call asks the database', () => {
  /**
   * The v1 onRequest hook authenticates so the rate limiter knows the caller's
   * plan, and each route guard then did it again — a second identical query,
   * HMAC and last_used_at write on every request. The guard now reuses the
   * hook's context, but only when the token is byte-identical.
   */
  test('the caller is authenticated once, not twice', async () => {
    await begin('auth-warm');
    const q = await queriesFor(() => begin('auth-1'));
    const lookups = q.filter((s) => /FROM api_keys k JOIN workspaces/.test(s));
    assert.equal(lookups.length, 1,
      `${lookups.length} api_keys lookups for one request; the guard should reuse `
      + "the hook's context when the token matches");
  });

  /**
   * A duplicate used to ask about the same row three times: a pre-check, an
   * INSERT that could only conflict, and a re-SELECT to find out what the row
   * said. Duplicates are the common path — an agent retrying is the entire
   * situation this product exists for.
   */
  test('a duplicate touches the effects row once', async () => {
    await begin('dupe-seed');
    const q = await queriesFor(() => begin('dupe-seed'));
    const touches = q.filter((s) => /FROM effects WHERE workspace_id|INTO effects/.test(s));
    assert.equal(touches.length, 1,
      `a replay issued ${touches.length} statements against the effects row:\n`
      + touches.map((t) => `  - ${t.slice(0, 90)}`).join('\n'));
  });

  test('a duplicate never takes the workspace lock', async () => {
    await begin('lock-seed');
    const q = await queriesFor(() => begin('lock-seed'));
    assert.equal(q.some((s) => /FROM workspaces WHERE id = \$1 FOR UPDATE/.test(s)), false,
      'a duplicate is not new work and must not serialise on the workspace row');
  });

  /**
   * Opening a transaction was two round trips before it had done anything —
   * paid by every transactional endpoint on every request.
   */
  test('opening a transaction is one round trip', async () => {
    const q = await queriesFor(() => begin(`tx-${Date.now()}`));
    const opens = q.filter((s) => /^BEGIN/.test(s.trim()));
    assert.equal(opens.length, 1);
    assert.match(opens[0]!, /BEGIN; SET LOCAL statement_timeout/,
      'BEGIN and the SET LOCALs should travel together');
  });

  /**
   * `observed` is read only inside the `ceiling !== null` branch, and no
   * ceiling is the default. Asking for the baseline anyway was a round trip
   * spent computing a number nothing would read.
   */
  test('no surge baseline is read when no ceiling is configured', async () => {
    const q = await queriesFor(() => begin(`surge-${Date.now()}`));
    assert.equal(q.some((s) => /SELECT baseline_count, baseline_hour/.test(s)), false,
      'the surge baseline was read despite no ceiling being configured');
  });
});
