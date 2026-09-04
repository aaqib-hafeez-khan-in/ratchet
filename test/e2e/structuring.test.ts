// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * The structuring analysis over real HTTP: who may read it, and what leaks.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const signup = async () => JSON.parse((await app.inject({
  method: 'POST', url: '/v1/workspaces',
  headers: { 'content-type': 'application/json' },
  payload: { name: 'st', email: `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test` },
})).payload);

const get = (url: string, key?: string) => app.inject({
  method: 'GET', url, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
});

/** Real gated effects, so the amounts under test travelled the real path. */
async function payouts(ws: { agent_api_key: string }, dollars: number, times: number, cp?: string) {
  for (let i = 0; i < times; i += 1) {
    await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
      payload: {
        effect_type: 'payment.payout', idempotency_key: `p-${dollars}-${i}-${Math.random()}`,
        payload: { i }, estimated_cost_micros: dollars * 1_000_000,
        ...(cp ? { dimensions: { counterparty: cp } } : {}),
      },
    });
  }
}

const watch = (key: string, micros: number | null) => app.inject({
  method: 'PUT', url: '/v1/policies/payment.payout',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: { structuring_threshold_micros: micros },
});

describe('who may read it', () => {
  test('the operator key can', async () => {
    const ws = await signup();
    const r = await get('/v1/analysis/structuring', ws.api_key);
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.ok(Array.isArray(body.findings));
    assert.ok(Array.isArray(body.without_threshold));
  });

  /** An agent that can see how close it is to being noticed can adjust. */
  test('the narrow agent key cannot', async () => {
    const ws = await signup();
    const r = await get('/v1/analysis/structuring', ws.agent_api_key);
    assert.ok(r.statusCode === 401 || r.statusCode === 403, `answered ${r.statusCode}`);
  });

  test('no credential gets nothing', async () => {
    assert.ok([401, 403].includes((await get('/v1/analysis/structuring')).statusCode));
  });
});

describe('through the real path', () => {
  test('amounts declared on begin are what gets measured', async () => {
    const ws = await signup();
    assert.equal((await watch(ws.api_key, 10_000_000_000)).statusCode, 200);

    await payouts(ws, 9_800, 12, 'acct_hug');
    await payouts(ws, 8_500, 2);

    const r = JSON.parse((await get('/v1/analysis/structuring', ws.api_key)).payload);
    assert.equal(r.findings.length, 1, JSON.stringify(r.examined_types));
    const f = r.findings[0];
    assert.equal(f.just_below, 12);
    assert.equal(f.control, 2);
    assert.equal(f.excess_ratio, 6);
    assert.equal(f.threshold_source, 'structuring_threshold');
    assert.equal(f.concentrated_in[0].dimension, 'counterparty');
    assert.match(f.concentrated_in[0].blinded, /^[0-9a-f]{32}$/);
  });

  test('the counterparty the bunching sits on is never named', async () => {
    const ws = await signup();
    await watch(ws.api_key, 10_000_000_000);
    await payouts(ws, 9_800, 12, 'acct_1234567890secret');
    const payload = (await get('/v1/analysis/structuring', ws.api_key)).payload;
    assert.equal(payload.includes('acct_1234567890secret'), false);
  });

  test('the watch line refuses nothing', async () => {
    const ws = await signup();
    await watch(ws.api_key, 1_000_000);        // $1 watch line
    const r = await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
      payload: {
        effect_type: 'payment.payout', idempotency_key: `big-${Date.now()}`,
        payload: {}, estimated_cost_micros: 5_000_000_000,
      },
    });
    assert.equal(r.statusCode, 200, 'an observation threshold must never gate');
    assert.equal(JSON.parse(r.payload).decision, 'execute');
  });

  test('the policy reads the threshold back', async () => {
    const ws = await signup();
    await watch(ws.api_key, 10_000_000_000);
    const p = JSON.parse((await get('/v1/policies/payment.payout', ws.api_key)).payload);
    assert.equal(p.structuring_threshold_micros, 10_000_000_000);
  });
});

describe('isolation and contract', () => {
  test('one workspace never sees another\'s bunching', async () => {
    const a = await signup(), b = await signup();
    await watch(a.api_key, 10_000_000_000);
    await payouts(a, 9_800, 12);

    const theirs = JSON.parse((await get('/v1/analysis/structuring', b.api_key)).payload);
    assert.deepEqual(theirs.findings, []);
    assert.deepEqual(theirs.examined_types, []);
  });

  test('it is in the published contract, described as a hint', async () => {
    const doc = JSON.parse((await get('/openapi.json')).payload);
    const op = doc.paths['/v1/analysis/structuring'].get;
    assert.ok(op, 'the endpoint is missing from the contract');
    assert.match(op.description, /rather than conclusions|somewhere to look/i,
      'the contract must not present a bunching count as a finding of fraud');
  });

  test('a silly window is refused', async () => {
    const ws = await signup();
    assert.equal((await get('/v1/analysis/structuring?days=99999', ws.api_key)).statusCode, 400);
  });
});
