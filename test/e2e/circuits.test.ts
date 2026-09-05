// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The circuit breaker over HTTP.
 *
 * The authorization test is the one that matters. A breaker exists to stop an
 * agent; an agent that can close its own breaker has not been stopped. These
 * routes take a console session or an admin key, never the key-only path that
 * `begin` and `report` use.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { setupDb, freshWorkspace, keyWithScopes, getPool, closePool } from '../helpers.js';

describe('circuit breaker HTTP surface', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
  after(async () => { await app.close(); await closePool(); });

  const admin = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

  test('an agent key cannot open or close a breaker', async () => {
    const ws = await freshWorkspace();
    const agentKey = await keyWithScopes(ws.workspaceId, ['effects:begin', 'effects:report']);
    for (const url of ['/v1/circuits/email.send/open', '/v1/circuits/email.send/close']) {
      const r = await app.inject({ method: 'POST', url, headers: admin(agentKey.plaintext),
        payload: { reason: 'let me out' } });
      assert.ok(r.statusCode === 401 || r.statusCode === 403,
        `${url} must not accept an agent key, got ${r.statusCode}`);
    }
    const list = await app.inject({ method: 'GET', url: '/v1/circuits',
      headers: admin(agentKey.plaintext) });
    assert.ok(list.statusCode === 401 || list.statusCode === 403);
  });

  test('the emergency stop halts every effect type', async () => {
    const ws = await freshWorkspace();
    const open = await app.inject({ method: 'POST', url: '/v1/circuits/*/open',
      headers: admin(ws.key.plaintext),
      payload: { action: 'deny', reason: 'agent misbehaving' } });
    assert.equal(open.statusCode, 200);
    const body = JSON.parse(open.payload);
    assert.equal(body.effect_type, '*');
    assert.equal(body.state, 'open');
    assert.equal(body.resets_at, null, 'a hand-pulled stop must not expire on its own');

    const blocked = await app.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: admin(ws.key.plaintext),
      payload: { effect_type: 'anything.at.all', idempotency_key: 'x-1' } });
    assert.equal(JSON.parse(blocked.payload).decision, 'denied');

    const close = await app.inject({ method: 'POST', url: '/v1/circuits/*/close',
      headers: admin(ws.key.plaintext), payload: {} });
    assert.equal(close.statusCode, 200);
    assert.equal(JSON.parse(close.payload).state, 'closed');

    const ok = await app.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: admin(ws.key.plaintext),
      payload: { effect_type: 'anything.at.all', idempotency_key: 'x-2' } });
    assert.equal(JSON.parse(ok.payload).decision, 'execute');
  });

  test('listing reports the volume a threshold would be set against', async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/v1/effects/begin',
        headers: admin(ws.key.plaintext),
        payload: { effect_type: 'measure.me', idempotency_key: `m-${i}` } });
    }
    const r = await app.inject({ method: 'GET', url: '/v1/circuits',
      headers: admin(ws.key.plaintext) });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    const row = body.rates.find((x: { effect_type: string }) => x.effect_type === 'measure.me');
    assert.equal(row.this_hour, 3);
    assert.equal(row.peak_hour, 3);
  });

  test('the policy route round-trips the surge settings', async () => {
    const ws = await freshWorkspace();
    const put = await app.inject({ method: 'PUT', url: '/v1/policies/surge.cfg',
      headers: admin(ws.key.plaintext),
      payload: { mode: 'allow', surge_per_hour: 25, surge_action: 'deny',
                 surge_cooldown_seconds: 900 } });
    assert.equal(put.statusCode, 200);
    const body = JSON.parse(put.payload);
    assert.equal(body.surge_per_hour, 25);
    assert.equal(body.surge_action, 'deny');
    assert.equal(body.surge_cooldown_seconds, 900);

    const get = await app.inject({ method: 'GET', url: '/v1/policies/surge.cfg',
      headers: admin(ws.key.plaintext) });
    assert.equal(JSON.parse(get.payload).surge_per_hour, 25);
  });

  test('require_cost is finally reported back', async () => {
    // It was declared in the schema but never serialised, so an operator who
    // turned it on saw nothing in the response confirming it.
    const ws = await freshWorkspace();
    const r = await app.inject({ method: 'PUT', url: '/v1/policies/cost.cfg',
      headers: admin(ws.key.plaintext),
      payload: { mode: 'allow', require_cost: true } });
    assert.equal(JSON.parse(r.payload).require_cost, true);
  });

  test('an invalid effect type is refused, but "*" is allowed', async () => {
    const ws = await freshWorkspace();
    const bad = await app.inject({ method: 'POST', url: '/v1/circuits/NOT VALID/open',
      headers: admin(ws.key.plaintext), payload: { reason: 'x' } });
    assert.equal(bad.statusCode, 400);
    const star = await app.inject({ method: 'POST', url: '/v1/circuits/*/open',
      headers: admin(ws.key.plaintext), payload: { reason: 'x' } });
    assert.equal(star.statusCode, 200);
  });

  test('opening requires a reason, so the audit trail is never blank', async () => {
    const ws = await freshWorkspace();
    const r = await app.inject({ method: 'POST', url: '/v1/circuits/no.reason/open',
      headers: admin(ws.key.plaintext), payload: {} });
    assert.equal(r.statusCode, 400);
  });

  test('closing a breaker that does not exist is a 404, not a silent success', async () => {
    const ws = await freshWorkspace();
    const r = await app.inject({ method: 'POST', url: '/v1/circuits/never.tripped/close',
      headers: admin(ws.key.plaintext), payload: {} });
    assert.equal(r.statusCode, 404);
  });

  test('a breaker in one workspace is invisible to another', async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    await app.inject({ method: 'POST', url: '/v1/circuits/*/open',
      headers: admin(a.key.plaintext), payload: { reason: 'a stops' } });
    const list = await app.inject({ method: 'GET', url: '/v1/circuits',
      headers: admin(b.key.plaintext) });
    assert.deepEqual(JSON.parse(list.payload).circuits, []);
    const ok = await app.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: admin(b.key.plaintext),
      payload: { effect_type: 'unaffected.op', idempotency_key: 'u-1' } });
    assert.equal(JSON.parse(ok.payload).decision, 'execute');
  });

  test('the opened breaker is recorded in the audit trail', async () => {
    const ws = await freshWorkspace();
    await app.inject({ method: 'POST', url: '/v1/circuits/audit.me/open',
      headers: admin(ws.key.plaintext), payload: { reason: 'looked wrong' } });
    const { rows } = await getPool().query(
      `SELECT action, subject_id, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'circuit.opened'`, [ws.workspaceId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_id, 'audit.me');
    assert.equal(rows[0].detail.reason, 'looked wrong');
  });
});

describe('signup issues a key an agent cannot misuse', () => {
  let app2: Awaited<ReturnType<typeof buildApp>>;
  before(async () => { app2 = await buildApp({ logger: false }); await app2.ready(); });
  after(async () => { await app2.close(); });

  test('the agent key cannot close a circuit breaker', async () => {
    // The whole point. The key a quickstart invites you to paste into an agent
    // must not be able to switch off the containment holding that agent back.
    const r = await app2.inject({ method: 'POST', url: '/v1/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'scoped-signup', email: `s-${Date.now()}@example.test` } });
    assert.equal(r.statusCode, 201);
    const body = JSON.parse(r.payload);
    assert.ok(body.agent_api_key?.startsWith('rk_'), 'signup must return an agent key');
    assert.notEqual(body.agent_api_key, body.api_key, 'and it must be a different key');

    const agent = { authorization: `Bearer ${body.agent_api_key}`,
                    'content-type': 'application/json' };

    // It can do the job it exists for.
    const gate = await app2.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: agent, payload: { effect_type: 'scoped.op', idempotency_key: 'k-1' } });
    assert.equal(JSON.parse(gate.payload).decision, 'execute');

    // And nothing else. Each body is valid for its own route, so what refuses
    // these is the authorization guard and not schema validation — Fastify
    // validates before preHandler, and a 400 would prove nothing about scopes.
    const forbidden: Array<[ 'GET' | 'POST' | 'PUT', string, object | undefined ]> = [
      ['POST', '/v1/circuits/*/open', { action: 'deny', reason: 'let me out' }],
      ['POST', '/v1/circuits/scoped.op/close', {}],
      ['GET', '/v1/circuits', undefined],
      ['PUT', '/v1/policies/scoped.op', { mode: 'allow', surge_per_hour: 999999 }],
      ['POST', '/v1/keys', { name: 'escalate', scopes: ['policies:write'] }],
    ];
    for (const [method, url, payload] of forbidden) {
      const res = await app2.inject({ method, url, headers: agent, payload });
      assert.ok(res.statusCode === 401 || res.statusCode === 403,
        `${method} ${url} must refuse an agent key for lack of scope, got ${res.statusCode}`);
    }
  });

  test('the operator key still works for everything', async () => {
    const r = await app2.inject({ method: 'POST', url: '/v1/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'op-signup', email: `o-${Date.now()}@example.test` } });
    const body = JSON.parse(r.payload);
    const op = { authorization: `Bearer ${body.api_key}`, 'content-type': 'application/json' };
    const open = await app2.inject({ method: 'POST', url: '/v1/circuits/*/open',
      headers: op, payload: { action: 'deny', reason: 'operator can' } });
    assert.equal(open.statusCode, 200);
  });
});

describe('the keys signup issues do not eat the plan allowance', () => {
  let app3: Awaited<ReturnType<typeof buildApp>>;
  before(async () => { app3 = await buildApp({ logger: false }); await app3.ready(); });
  after(async () => { await app3.close(); });

  test('a free workspace can still create two keys of its own', async () => {
    // Signup mints two keys for you — an operator key and a gate-only agent
    // key. Keys the service creates must not consume the allowance that was
    // sold, and this broke exactly once: adding the agent key silently halved
    // what a free workspace could create.
    const r = await app3.inject({ method: 'POST', url: '/v1/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'quota', email: `q-${Date.now()}@example.test` } });
    const body = JSON.parse(r.payload);
    const op = { authorization: `Bearer ${body.api_key}`, 'content-type': 'application/json' };

    for (const n of ['mine-1', 'mine-2']) {
      const made = await app3.inject({ method: 'POST', url: '/v1/keys', headers: op,
        payload: { name: n, scopes: ['effects:read'] } });
      assert.equal(made.statusCode, 201, `${n} should be allowed`);
    }
    const third = await app3.inject({ method: 'POST', url: '/v1/keys', headers: op,
      payload: { name: 'mine-3', scopes: ['effects:read'] } });
    assert.equal(third.statusCode, 403, 'and the ceiling still exists');
  });
});
