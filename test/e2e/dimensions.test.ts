// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Dimensions over real HTTP: the wire contract, and the refusals a caller sees.
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
  payload: { name: 'd', email: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test` },
})).payload);

const begin = (key: string, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/v1/effects/begin',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: body,
});

const setPolicy = (key: string, type: string, body: Record<string, unknown>) => app.inject({
  method: 'PUT', url: `/v1/policies/${type}`,
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: body,
});

describe('the wire contract', () => {
  test('a policy round-trips its dimension rules', async () => {
    const ws = await signup();
    const put = await setPolicy(ws.api_key, 'payment.refund', {
      required_dimensions: ['counterparty'],
      dimension_limits: { counterparty: { daily_micros: 500_000_000, daily_count: 3 } },
    });
    assert.equal(put.statusCode, 200, put.payload.slice(0, 300));

    const got = JSON.parse((await app.inject({
      method: 'GET', url: '/v1/policies/payment.refund',
      headers: { authorization: `Bearer ${ws.api_key}` },
    })).payload);
    assert.deepEqual(got.required_dimensions, ['counterparty']);
    assert.deepEqual(got.dimension_limits.counterparty, { daily_micros: 500_000_000, daily_count: 3 });
  });

  test('both endpoints appear in the published contract', async () => {
    const doc = JSON.parse((await app.inject({ method: 'GET', url: '/openapi.json' })).payload);
    const body = doc.paths['/v1/effects/begin'].post.requestBody.content['application/json'].schema;
    assert.ok(body.properties.dimensions, 'begin must publish the dimensions field');
    assert.match(JSON.stringify(body.properties.dimensions), /keyed hash/,
      'and must say what happens to the value');
  });

  test('a malformed dimension is refused, and leaves nothing behind', async () => {
    const ws = await signup();
    for (const dims of [
      { 'Bad Name': 'x' },        // could not be a scope key
      { ok: '' },                 // names a bucket that means nothing
      { ok: { nested: 1 } },      // not a scalar
      { ok: ['a', 'b'] },         // ambiguous: which one is the counterparty?
      { ok: null },
    ]) {
      const r = await begin(ws.agent_api_key, {
        effect_type: 'email.send', idempotency_key: `bad-${Math.random()}`,
        payload: {}, dimensions: dims,
      });
      assert.equal(r.statusCode, 400, `${JSON.stringify(dims)} was accepted`);
    }
    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM effects WHERE workspace_id = $1', [ws.workspace_id]);
    assert.equal(rows[0].n, 0, 'a refused request must leave nothing behind');
  });

  /**
   * Fastify configures ajv with coerceTypes:'array', so 42, true and ["a"] all
   * arrive as strings rather than as errors. That is the right outcome — an
   * account number that happens to be digits should work — and what matters is
   * that the result is still one well-defined string. This pins the property
   * rather than the framework: whatever survives validation is stored as a
   * 32-character blind and never as anything structured.
   */
  test('a scalar that is not a string still becomes exactly one blinded value', async () => {
    const ws = await signup();
    for (const value of [42, true, ['a']]) {
      const r = await begin(ws.agent_api_key, {
        effect_type: 'email.send', idempotency_key: `co-${Math.random()}`,
        payload: {}, dimensions: { ok: value },
      });
      assert.equal(r.statusCode, 200, `${JSON.stringify(value)} was refused`);
      const { rows } = await getPool().query<{ dimensions: Record<string, string> }>(
        'SELECT dimensions FROM effects WHERE id = $1', [JSON.parse(r.payload).effect_id]);
      assert.match(rows[0]!.dimensions.ok!, /^[0-9a-f]{32}$/,
        `${JSON.stringify(value)} did not become a single blinded value`);
    }
  });
});

describe('what a caller is told', () => {
  test('a missing required dimension names the field and explains the storage', async () => {
    const ws = await signup();
    await setPolicy(ws.api_key, 'payment.refund', { required_dimensions: ['counterparty'] });

    const r = await begin(ws.agent_api_key, {
      effect_type: 'payment.refund', idempotency_key: `m-${Date.now()}`, payload: {},
    });
    assert.equal(r.statusCode, 400);
    const err = JSON.parse(r.payload).error;
    assert.equal(err.code, 'dimension_required');
    assert.match(err.message, /"counterparty"/);
    assert.match(err.message, /never sees it/, 'a caller sending an account number deserves this');
    assert.deepEqual(err.detail.missing, ['counterparty']);
  });

  test('a counterparty ceiling refuses with the numbers to act on', async () => {
    const ws = await signup();
    await setPolicy(ws.api_key, 'payment.refund', {
      dimension_limits: { counterparty: { daily_micros: 1_000_000, daily_count: null } },
    });
    const dims = { counterparty: 'acct_wire' };

    const first = await begin(ws.agent_api_key, {
      effect_type: 'payment.refund', idempotency_key: `w1-${Date.now()}`,
      payload: { a: 1 }, estimated_cost_micros: 900_000, dimensions: dims });
    assert.equal(first.statusCode, 200);

    const second = await begin(ws.agent_api_key, {
      effect_type: 'payment.refund', idempotency_key: `w2-${Date.now()}`,
      payload: { a: 2 }, estimated_cost_micros: 900_000, dimensions: dims });
    assert.equal(second.statusCode, 403);
    const err = JSON.parse(second.payload).error;
    assert.equal(err.code, 'budget_exceeded');
    assert.match(err.detail.scope, /^dim:counterparty:[0-9a-f]{32}$/,
      'the scope says which ceiling, without saying which counterparty');
    assert.ok(err.detail.resetsAt, 'and when it clears');
  });

  test('a velocity refusal reads as a count, not as money', async () => {
    const ws = await signup();
    await setPolicy(ws.api_key, 'email.send', {
      dimension_limits: { recipient: { daily_micros: null, daily_count: 1 } },
    });
    const dims = { recipient: 'target@example.test' };
    await begin(ws.agent_api_key, {
      effect_type: 'email.send', idempotency_key: `v1-${Date.now()}`, payload: { a: 1 },
      dimensions: dims });
    const r = await begin(ws.agent_api_key, {
      effect_type: 'email.send', idempotency_key: `v2-${Date.now()}`, payload: { a: 2 },
      dimensions: dims });
    assert.equal(r.statusCode, 403);
    const err = JSON.parse(r.payload).error;
    assert.match(err.message, /daily limit of 1 effects/);
    assert.equal(err.detail.countLimit, 1);
  });
});

describe('what must never leak', () => {
  test('the value a caller sent is not echoed back in any response', async () => {
    const ws = await signup();
    await setPolicy(ws.api_key, 'payment.refund', {
      dimension_limits: { counterparty: { daily_micros: 1, daily_count: null } },
    });
    const secret = 'acct_9999888877776666';

    const ok = await begin(ws.agent_api_key, {
      effect_type: 'payment.refund', idempotency_key: `s1-${Date.now()}`,
      payload: {}, dimensions: { counterparty: secret } });
    const refused = await begin(ws.agent_api_key, {
      effect_type: 'payment.refund', idempotency_key: `s2-${Date.now()}`,
      payload: {}, estimated_cost_micros: 10, dimensions: { counterparty: secret } });

    for (const r of [ok, refused]) {
      assert.equal(r.payload.includes(secret), false,
        'a refusal that quotes the account number defeats the point of blinding it');
    }

    const view = await app.inject({
      method: 'GET', url: '/v1/effects?limit=10',
      headers: { authorization: `Bearer ${ws.api_key}` },
    });
    assert.equal(view.payload.includes(secret), false, 'and it is not in the read model either');
  });

  test('the agent key cannot set the ceilings it is subject to', async () => {
    const ws = await signup();
    const r = await setPolicy(ws.agent_api_key, 'payment.refund', {
      dimension_limits: { counterparty: { daily_micros: 999_999_999_999, daily_count: null } },
    });
    assert.ok(r.statusCode === 401 || r.statusCode === 403,
      'an agent that can raise its own counterparty ceiling is not contained');
  });
});
