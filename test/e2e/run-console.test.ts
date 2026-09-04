/**
 * Run budgets from the console.
 *
 * The wallet endpoint was key-only, which meant the person who dispatches the
 * work could not set a ceiling from the browser — they had to hold an API key to
 * do the one thing the page exists for. It now takes a session OR a key with
 * policies:write.
 *
 * That widening is the thing worth testing carefully, because the asymmetry it
 * sits next to is the whole control: an agent may READ what it has left, so it
 * can take a cheaper path or stop cleanly, and must never be able to raise its
 * own ceiling. A session belongs to an operator; an agent has no cookie and no
 * policies:write. Both halves are asserted below.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let adminKey: string;
let cookie: string;
let agentKey: string;

const j = (r: { payload: string }) => JSON.parse(r.payload);
const $ = (d: number) => Math.round(d * 1_000_000);

before(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.ready();

  const res = await app.inject({
    method: 'POST', url: '/v1/workspaces',
    payload: { name: 'Runs Co', email: `runs-${Date.now()}@example.test` },
  });
  assert.equal(res.statusCode, 201);
  adminKey = j(res).api_key;
  cookie = (res.headers['set-cookie'] as string).split(';')[0]!;

  // A key shaped like the one an agent actually gets.
  const made = j(await app.inject({
    method: 'POST', url: '/v1/keys', headers: { cookie },
    payload: { name: 'agent', scopes: ['effects:begin', 'effects:read'] },
  }));
  agentKey = made.api_key ?? made.key ?? made.plaintext;
});
after(async () => { await app.close(); await closePool(); });

const put = (headers: Record<string, string>, runId = 'run-1', limit = $(50)) =>
  app.inject({
    method: 'PUT', url: `/v1/runs/${runId}/budget`,
    headers, payload: { limit_micros: limit },
  });

describe('who may open a wallet', () => {
  test('an operator with a session can, which is the point of the page', async () => {
    const r = await put({ cookie });
    assert.equal(r.statusCode, 200);
    assert.equal(j(r).limit_micros, $(50));
  });

  test('a key with policies:write still can', async () => {
    const r = await put({ authorization: `Bearer ${adminKey}` }, 'run-key');
    assert.equal(r.statusCode, 200);
  });

  test('an agent key cannot raise its own ceiling', async () => {
    const r = await put({ authorization: `Bearer ${agentKey}` }, 'run-agent');
    assert.equal(r.statusCode, 403,
      'this is the asymmetry the whole control rests on — an agent that can lift '
      + 'its own limit has no limit');
  });

  test('no credential at all is refused', async () => {
    assert.equal((await put({}, 'run-anon')).statusCode, 401);
  });
});

describe('the listing the console reads', () => {
  test('a session can read it', async () => {
    const r = await app.inject({ url: '/v1/runs', headers: { cookie } });
    assert.equal(r.statusCode, 200);
    assert.ok(Array.isArray(j(r).runs));
  });

  test('it carries the wallet and says the spend was counted', async () => {
    await put({ cookie }, 'run-listed', $(80));
    const { runs } = j(await app.inject({ url: '/v1/runs', headers: { cookie } }));
    const row = runs.find((x: any) => x.run_id === 'run-listed');
    assert.ok(row);
    assert.equal(row.limit_micros, $(80));
    assert.equal(row.spend_source, 'wallet');
    assert.equal(row.remaining_micros, $(80));
    assert.equal(row.exhausted, false);
  });

  test('an unbudgeted run is listed, and its spend is marked as declared', async () => {
    await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { authorization: `Bearer ${adminKey}` },
      payload: {
        effect_type: 'payment.payout', idempotency_key: `free-${Date.now()}`,
        payload: { x: 1 }, estimated_cost_micros: $(12), run_id: 'run-uncapped',
      },
    });
    const { runs } = j(await app.inject({ url: '/v1/runs', headers: { cookie } }));
    const row = runs.find((x: any) => x.run_id === 'run-uncapped');
    assert.ok(row, 'the run with nothing bounding it is the row the page exists to surface');
    assert.equal(row.limit_micros, null);
    assert.equal(row.spend_source, 'declared',
      'the gate enforced nothing here, and the number must not claim otherwise');
  });

  test('an anonymous caller gets nothing', async () => {
    assert.equal((await app.inject({ url: '/v1/runs' })).statusCode, 401);
  });

  test('a silly window is refused rather than served', async () => {
    const r = await app.inject({ url: '/v1/runs?days=999', headers: { cookie } });
    assert.equal(r.statusCode, 400);
  });
});
