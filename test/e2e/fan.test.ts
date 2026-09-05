// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The fan analysis over real HTTP: who may read it, and what never leaves.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const signup = async () => JSON.parse((await app.inject({
  method: 'POST', url: '/v1/workspaces',
  headers: { 'content-type': 'application/json' },
  payload: { name: 'fan', email: `fan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test` },
})).payload);

const get = (url: string, key?: string) => app.inject({
  method: 'GET', url, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
});

async function payout(ws: { agent_api_key: string }, cp: string, run: string, agent: string) {
  await app.inject({
    method: 'POST', url: '/v1/effects/begin',
    headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
    payload: {
      effect_type: 'payment.payout', idempotency_key: `f-${cp}-${run}-${Math.random()}`,
      payload: { cp }, agent_id: agent, run_id: run,
      dimensions: { counterparty: cp },
    },
  });
}

describe('who may read it', () => {
  test('the operator key can', async () => {
    const ws = await signup();
    const r = await get('/v1/analysis/fan', ws.api_key);
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.payload);
    assert.equal(b.dimension, 'counterparty');
    assert.ok(Array.isArray(b.fan_out) && Array.isArray(b.fan_in));
  });

  test('the narrow agent key cannot', async () => {
    const ws = await signup();
    const r = await get('/v1/analysis/fan', ws.agent_api_key);
    assert.ok(r.statusCode === 401 || r.statusCode === 403, `answered ${r.statusCode}`);
  });
});

describe('through the real path', () => {
  test('a run reaching many brand-new counterparties is reported', async () => {
    const ws = await signup();
    for (let i = 0; i < 25; i += 1) await payout(ws, `acct_new_${i}`, 'disbursement', 'payer');

    const b = JSON.parse((await get('/v1/analysis/fan', ws.api_key)).payload);
    assert.equal(b.counterparties_in_window, 25);
    const f = b.fan_out.find((x: { id: string }) => x.id === 'disbursement');
    assert.ok(f, JSON.stringify(b.fan_out));
    assert.equal(f.distinct_counterparties, 25);
    assert.equal(f.first_seen, 25);
    assert.equal(f.new_share, 1);
    assert.match(f.detail, /question rather than an answer/i);
  });

  test('one counterparty fed by three agents is reported', async () => {
    const ws = await signup();
    for (const agent of ['refunder', 'payouts', 'ops']) {
      await payout(ws, 'acct_collector', `r-${agent}`, agent);
    }
    const b = JSON.parse((await get('/v1/analysis/fan', ws.api_key)).payload);
    assert.equal(b.fan_in.length, 1);
    assert.equal(b.fan_in[0].distinct_agents, 3);
    assert.match(b.fan_in[0].blinded, /^[0-9a-f]{32}$/);
  });

  test('no counterparty value ever appears in the response', async () => {
    const ws = await signup();
    for (let i = 0; i < 22; i += 1) await payout(ws, `acct_secret_${i}`, 'batch', 'payer');
    for (const agent of ['a', 'b', 'c']) await payout(ws, 'acct_secret_hub', `r-${agent}`, agent);

    const payload = (await get('/v1/analysis/fan', ws.api_key)).payload;
    assert.equal(payload.includes('acct_secret_'), false,
      'the analysis must not be where the blinding leaks');
  });

  test('a dimension nobody declared reports nothing rather than failing', async () => {
    const ws = await signup();
    for (let i = 0; i < 25; i += 1) await payout(ws, `acct_${i}`, 'batch', 'payer');
    const b = JSON.parse((await get('/v1/analysis/fan?dimension=recipient', ws.api_key)).payload);
    assert.equal(b.counterparties_in_window, 0);
    assert.deepEqual(b.fan_out, []);
  });
});

describe('input and contract', () => {
  test('a dimension name that could not be one is refused', async () => {
    const ws = await signup();
    const r = await get('/v1/analysis/fan?dimension=Bad%20Name', ws.api_key);
    assert.equal(r.statusCode, 400);
  });

  test('a caller cannot smuggle SQL through the dimension', async () => {
    const ws = await signup();
    const r = await get("/v1/analysis/fan?dimension=x'%3B DROP TABLE effects--", ws.api_key);
    assert.equal(r.statusCode, 400, 'the pattern refuses it before it reaches a query');
    // And the table is very much still there.
    assert.equal((await get('/v1/analysis/fan', ws.api_key)).statusCode, 200);
  });

  test('it is in the published contract, described as a question', async () => {
    const doc = JSON.parse((await get('/openapi.json')).payload);
    const op = doc.paths['/v1/analysis/fan'].get;
    assert.ok(op);
    assert.match(op.description, /Neither is a verdict/i);
    assert.match(op.description, /payroll/i,
      'the legitimate case has to be named, or the reader assumes width is guilt');
  });
});
