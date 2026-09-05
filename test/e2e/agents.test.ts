// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The agent reliability endpoints over real HTTP.
 *
 * The point of these is the boundary, not the arithmetic — that is covered in
 * test/integration/agent-quality.test.ts. What must hold here: an agent cannot
 * read its own report card, and no workspace can read another's.
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
  payload: { name: 'ag', email: `ag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test` },
})).payload);

const get = (url: string, key?: string) => app.inject({
  method: 'GET', url, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
});

/** One real gated effect, so there is genuinely an agent to ask about. */
const gate = (key: string, idem: string, agent: string) => app.inject({
  method: 'POST', url: '/v1/effects/begin',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: { effect_type: 'email.send', idempotency_key: idem, agent_id: agent, payload: {} },
});

describe('who may read a report card', () => {
  test('the operator key can', async () => {
    const ws = await signup();
    await gate(ws.agent_api_key, `a-${Date.now()}`, 'billing-bot');
    const r = await get('/v1/agents', ws.api_key);
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.deepEqual(body.data.map((a: { agent_id: string }) => a.agent_id), ['billing-bot']);
  });

  /**
   * Every metric here is one an agent could flatter by doing less. An agent that
   * can read its own grade can work out which signal to stop emitting.
   */
  test('the narrow agent key cannot', async () => {
    const ws = await signup();
    await gate(ws.agent_api_key, `b-${Date.now()}`, 'billing-bot');
    for (const url of ['/v1/agents', '/v1/agents/billing-bot/reliability']) {
      const r = await get(url, ws.agent_api_key);
      assert.ok(r.statusCode === 401 || r.statusCode === 403,
        `${url} answered ${r.statusCode} to the key an agent holds`);
    }
  });

  test('no credential at all gets nothing', async () => {
    const r = await get('/v1/agents');
    assert.ok(r.statusCode === 401 || r.statusCode === 403);
  });
});

describe('tenant isolation', () => {
  test('one workspace cannot read another workspace\'s agent', async () => {
    const a = await signup(), b = await signup();
    await gate(a.agent_api_key, `iso-${Date.now()}`, 'private-bot');

    const mine = JSON.parse((await get('/v1/agents', a.api_key)).payload);
    assert.deepEqual(mine.data.map((x: { agent_id: string }) => x.agent_id), ['private-bot']);
    // The console prints this alongside "not enough yet", so it must be the
    // denominator the rate was actually computed over — not the effect count,
    // which includes effects still in flight that have concluded nothing.
    assert.equal(typeof mine.data[0].concluded, 'number');

    const theirs = JSON.parse((await get('/v1/agents', b.api_key)).payload);
    assert.deepEqual(theirs.data, [], 'another workspace sees none of it');

    const probe = await get('/v1/agents/private-bot/reliability', b.api_key);
    assert.equal(probe.statusCode, 404,
      'and a direct lookup must not confirm the agent exists somewhere');
  });
});

describe('the profile', () => {
  test('a real gated effect produces a real profile', async () => {
    const ws = await signup();
    const idem = `p-${Date.now()}`;
    const begun = JSON.parse((await gate(ws.agent_api_key, idem, 'worker-1')).payload);
    assert.equal(begun.decision, 'execute');

    await app.inject({
      method: 'POST', url: `/v1/effects/${begun.effect_id}/report`,
      headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
      payload: { lease_token: begun.lease_token, outcome: 'succeeded' },
    });

    const p = JSON.parse((await get('/v1/agents/worker-1/reliability', ws.api_key)).payload);
    assert.equal(p.agent_id, 'worker-1');
    assert.equal(p.volume.effects, 1);
    assert.equal(p.reporting.reported, 1);
    assert.equal(p.reporting.report_rate, null, 'one effect is not a rate');
    assert.equal(p.decisions.execute, 1, 'the receipt of the begin call is counted');
    assert.deepEqual(p.concerns, []);
  });

  /**
   * The lease columns were added mid-life. An effect gated through the real path
   * must actually carry them, or the metric silently measures nothing forever.
   */
  test('a lease taken through the real path records when it was taken', async () => {
    const ws = await signup();
    const begun = JSON.parse((await gate(ws.agent_api_key, `l-${Date.now()}`, 'worker-2')).payload);
    const { rows } = await getPool().query<{ lease_granted_at: Date | null }>(
      'SELECT lease_granted_at FROM effects WHERE id = $1', [begun.effect_id]);
    assert.ok(rows[0]?.lease_granted_at instanceof Date,
      'grantLease must stamp when permission was actually taken');
  });

  test('a declared cost survives the report that zeroes the reservation', async () => {
    const ws = await signup();
    const begun = JSON.parse((await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
      payload: {
        effect_type: 'email.send', idempotency_key: `c-${Date.now()}`,
        agent_id: 'worker-3', estimated_cost_micros: 250_000, payload: {},
      },
    })).payload);

    await app.inject({
      method: 'POST', url: `/v1/effects/${begun.effect_id}/report`,
      headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
      payload: { lease_token: begun.lease_token, outcome: 'succeeded', actual_cost_micros: 250_000 },
    });

    const { rows } = await getPool().query<{ declared_micros: string; reserved_micros: string }>(
      'SELECT declared_micros, reserved_micros FROM effects WHERE id = $1', [begun.effect_id]);
    assert.equal(Number(rows[0]?.reserved_micros), 0, 'the live reservation is released');
    assert.equal(Number(rows[0]?.declared_micros), 250_000,
      'but what the agent said it would cost is still on the record');
  });
});

describe('the list reports the sample it used', () => {
  test('an effect still in flight is counted as volume but not as concluded', async () => {
    const ws = await signup();
    await gate(ws.agent_api_key, `flight-a-${Date.now()}`, 'half-done');
    const b = JSON.parse((await gate(ws.agent_api_key, `flight-b-${Date.now()}`, 'half-done')).payload);
    await app.inject({
      method: 'POST', url: `/v1/effects/${b.effect_id}/report`,
      headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
      payload: { lease_token: b.lease_token, outcome: 'succeeded' },
    });

    const row = JSON.parse((await get('/v1/agents', ws.api_key)).payload)
      .data.find((a: { agent_id: string }) => a.agent_id === 'half-done');
    assert.equal(row.effects, 2);
    assert.equal(row.concluded, 1, 'a live lease has concluded nothing');
    assert.equal(row.report_rate, null, 'and one sample is not a rate');
  });
});

describe('input handling', () => {
  test('a window outside the allowed range is refused, not silently clamped', async () => {
    const ws = await signup();
    const r = await get('/v1/agents?days=99999', ws.api_key);
    assert.equal(r.statusCode, 400);
  });

  test('an unknown query parameter is rejected rather than ignored', async () => {
    const ws = await signup();
    const r = await get('/v1/agents?dayz=7', ws.api_key);
    assert.equal(r.statusCode, 400, 'a caller\'s typo should not quietly become the default');
  });

  test('a valid window is honoured', async () => {
    const ws = await signup();
    const r = await get('/v1/agents?days=7', ws.api_key);
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.payload).window.days, 7);
  });
});

describe('the published contract', () => {
  test('both routes appear in the OpenAPI document', async () => {
    const doc = JSON.parse((await get('/openapi.json')).payload);
    assert.ok(doc.paths['/v1/agents'], 'the listing is missing from the contract');
    assert.ok(doc.paths['/v1/agents/{agentId}/reliability'], 'the profile is missing');
  });
});
