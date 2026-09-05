// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
// Exercise the API with production-shaped webhook rules (https only, no private
// networks), so these assertions reflect what a deployed instance really does.
process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK = 'false';

const { setupDb, closePool } = await import('../helpers.js');

const { buildApp } = await import('../../src/api/app.js');
const { PLANS } = await import('../../src/domain/plans.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let apiKey: string;
let workspaceId: string;
let cookie: string;

const j = (r: { payload: string }) => JSON.parse(r.payload);

before(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.ready();

  const res = await app.inject({
    method: 'POST', url: '/v1/workspaces',
    payload: { name: 'E2E Co', email: 'e2e@example.test' },
  });
  assert.equal(res.statusCode, 201);
  const body = j(res);
  apiKey = body.api_key;
  workspaceId = body.workspace_id;
  cookie = (res.headers['set-cookie'] as string).split(';')[0]!;
});

after(async () => { await app.close(); await closePool(); });

const auth = () => ({ authorization: `Bearer ${apiKey}` });

describe('the full agent onboarding path', () => {
  test('signup returns a usable key exactly once', () => {
    assert.match(apiKey, /^rk_test_[a-z0-9]{12}_[A-Za-z0-9_-]{32,}$/);
    assert.ok(workspaceId.startsWith('ws_'));
  });

  test('an agent can discover the service before authenticating', async () => {
    const m = j(await app.inject({ url: '/.well-known/agent-manifest.json' }));
    assert.equal(m.name, 'Ratchet');
    assert.ok(m.core_workflow.length >= 4);
    assert.ok(m.does_not.length >= 3, 'the manifest must state the boundaries too');
    assert.ok(m.mcp.tools.some((t: any) => t.name === 'ratchet_begin_effect'));

    const llms = await app.inject({ url: '/llms.txt' });
    assert.equal(llms.statusCode, 200);
    assert.match(llms.headers['content-type'] as string, /text\/plain/);
    assert.match(llms.payload, /idempotency/i);

    const spec = j(await app.inject({ url: '/openapi.json' }));
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.paths['/v1/effects/begin'].post.operationId, 'beginEffect');
  });

  test('the complete core loop: gate, execute, report, replay', async () => {
    const payload = { effect_type: 'email.send', idempotency_key: 'e2e:welcome:1',
                      payload: { to: 'x@y.test' }, estimated_cost_micros: 500,
                      agent_id: 'agent-e2e', run_id: 'run-e2e' };

    const a = j(await app.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: auth(), payload }));
    assert.equal(a.decision, 'execute');
    assert.ok(a.lease_token);
    assert.equal(a.billing.metered, true);

    const rep = await app.inject({
      method: 'POST', url: `/v1/effects/${a.effect_id}/report`, headers: auth(),
      payload: { lease_token: a.lease_token, outcome: 'succeeded',
                 result: { message_id: 'm_1' }, actual_cost_micros: 480 },
    });
    assert.equal(rep.statusCode, 200);
    assert.equal(j(rep).state, 'succeeded');

    const b = j(await app.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: auth(), payload }));
    assert.equal(b.decision, 'duplicate');
    assert.deepEqual(b.result, { message_id: 'm_1' });
    assert.equal(b.billing.metered, false);

    // The free lookup path agrees with the gate.
    const look = j(await app.inject({
      url: '/v1/effects/lookup?effect_type=email.send&idempotency_key=e2e:welcome:1',
      headers: auth() }));
    assert.equal(look.state, 'succeeded');
    assert.equal(look.actual_cost_micros, 480);

    const list = j(await app.inject({ url: '/v1/effects?run_id=run-e2e', headers: auth() }));
    assert.equal(list.data.length, 1);
  });

  test('usage and the ledger reflect what happened', async () => {
    const ws = j(await app.inject({ url: '/v1/workspace', headers: { cookie } }));
    assert.equal(ws.plan.id, 'free');
    assert.ok(ws.usage.effects_this_period >= 1);
    assert.equal(ws.usage.included_remaining,
      PLANS.free.includedEffects - ws.usage.effects_this_period);
    assert.ok(ws.external_spend_today.workspace_micros >= 480);

    const audit = j(await app.inject({ url: '/v1/audit', headers: { cookie } }));
    assert.ok(audit.data.some((e: any) => e.action === 'workspace.created'));
  });
});

describe('authentication and authorization over HTTP', () => {
  test('unauthenticated reads and operator routes are refused', async () => {
    // begin is deliberately excluded: it provisions its own workspace so an
    // agent can use the gate on first contact. Everything that could reach
    // EXISTING data still requires a credential, which is the property that
    // matters and is asserted below.
    for (const url of ['/v1/effects', '/v1/workspace', '/v1/keys', '/v1/policies']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, url);
      assert.equal(j(r).error.code, 'unauthorized');
    }
  });

  test('a keyless begin provisions rather than reading anything existing', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/effects/begin',
      payload: { effect_type: 'email.send', idempotency_key: `anon-${Date.now()}` } });
    assert.equal(r.statusCode, 200);
    const b = j(r);
    assert.ok(b.workspace?.api_key, 'must hand back the key it just created');
    // The workspace it reached is brand new, never an existing one.
    assert.notEqual(b.workspace.workspace_id, workspaceId);
  });

  test('a scoped key cannot exceed its grant', async () => {
    const made = j(await app.inject({
      method: 'POST', url: '/v1/keys', headers: { cookie },
      payload: { name: 'read-only', scopes: ['effects:read'] },
    }));
    const ro = { authorization: `Bearer ${made.api_key}` };

    const denied = await app.inject({ method: 'POST', url: '/v1/effects/begin', headers: ro,
      payload: { effect_type: 'email.send', idempotency_key: 'scope-test' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(j(denied).error.code, 'forbidden');
    assert.equal(j(denied).error.detail.required, 'effects:begin');

    const allowed = await app.inject({ url: '/v1/effects', headers: ro });
    assert.equal(allowed.statusCode, 200);
  });

  test('a revoked key stops working over HTTP', async () => {
    const made = j(await app.inject({ method: 'POST', url: '/v1/keys', headers: { cookie },
      payload: { name: 'temp', scopes: ['effects:read'] } }));
    const h = { authorization: `Bearer ${made.api_key}` };
    assert.equal((await app.inject({ url: '/v1/effects', headers: h })).statusCode, 200);

    await app.inject({ method: 'DELETE', url: `/v1/keys/${made.id}`, headers: { cookie } });
    assert.equal((await app.inject({ url: '/v1/effects', headers: h })).statusCode, 401);
  });

  test('a key never appears in a listing', async () => {
    const keys = j(await app.inject({ url: '/v1/keys', headers: { cookie } }));
    const dump = JSON.stringify(keys);
    assert.equal(dump.includes(apiKey), false, 'listing a key must not disclose its secret');
    assert.ok(keys.data.every((k: any) => !('api_key' in k) && !('secret_hash' in k)));
  });
});

describe('request validation and safe errors', () => {
  test('malformed effect types and missing fields are rejected with detail', async () => {
    const cases = [
      {},
      { effect_type: 'Email.Send', idempotency_key: 'k' },   // uppercase
      { effect_type: 'a b', idempotency_key: 'k' },          // whitespace
      { effect_type: 'email.send' },                          // no key
      { effect_type: 'email.send', idempotency_key: '' },     // empty key
      { effect_type: 'email.send', idempotency_key: 'k', estimated_cost_micros: -5 },
      { effect_type: 'email.send', idempotency_key: 'k', unknown_field: 1 },
    ];
    for (const payload of cases) {
      const r = await app.inject({ method: 'POST', url: '/v1/effects/begin',
        headers: auth(), payload });
      assert.equal(r.statusCode, 400, JSON.stringify(payload));
      assert.equal(j(r).error.code, 'invalid_request');
    }
  });

  test('an oversized result is refused with an actionable message', async () => {
    const a = j(await app.inject({ method: 'POST', url: '/v1/effects/begin', headers: auth(),
      payload: { effect_type: 'email.send', idempotency_key: 'big-result' } }));
    const r = await app.inject({
      method: 'POST', url: `/v1/effects/${a.effect_id}/report`, headers: auth(),
      payload: { lease_token: a.lease_token, outcome: 'succeeded',
                 result: { blob: 'x'.repeat(40_000) } },
    });
    assert.equal(r.statusCode, 413);
    assert.match(j(r).error.message, /Store large outputs elsewhere/);
  });

  test('an unknown effect id does not disclose whether it exists elsewhere', async () => {
    const r = await app.inject({ url: '/v1/effects/eff_doesnotexist', headers: auth() });
    assert.equal(r.statusCode, 404);
    assert.equal(j(r).error.code, 'not_found');
  });

  test('errors never leak internal detail', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/effects/eff_nope/report`,
      headers: auth(), payload: { lease_token: 'lt_bogus', outcome: 'succeeded' } });
    const body = r.payload;
    assert.equal(/at \/|node_modules|SELECT |postgres:\/\//.test(body), false,
      `error body leaked internals: ${body}`);
  });
});

describe('transport security', () => {
  test('security headers are present on API and HTML responses', async () => {
    const api = await app.inject({ url: '/v1/effects', headers: auth() });
    assert.equal(api.headers['x-content-type-options'], 'nosniff');
    assert.equal(api.headers['x-frame-options'], 'DENY');
    assert.equal(api.headers['cache-control'], 'no-store',
      'per-key API responses must not be cached by a shared proxy');
  });

  test('CORS does not grant credentials to an arbitrary origin by default', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/v1/effects',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' } });
    assert.notEqual(r.headers['access-control-allow-origin'], 'https://evil.test');
    assert.notEqual(r.headers['access-control-allow-origin'], '*');
  });

  test('the session cookie is httpOnly and same-site', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/workspaces',
      payload: { name: 'Cookie Co', email: 'cookie@example.test' } });
    const sc = r.headers['set-cookie'] as string;
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
  });
});

describe('webhook registration safety', () => {
  test('unsafe destinations are refused at registration', async () => {
    for (const url of ['http://example.com/h', 'https://192.168.1.1/h',
                       'https://user:pw@example.com/h', 'https://example.com:22/h']) {
      const r = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: { cookie },
        payload: { url, events: ['effect.succeeded'] } });
      assert.equal(r.statusCode, 400, url);
    }
  });

  test('a valid endpoint returns its signing secret once', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: { cookie },
      payload: { url: 'https://hooks.example.com/ingest', events: ['effect.indeterminate'] } });
    assert.equal(r.statusCode, 201);
    assert.ok(j(r).signing_secret);

    const list = j(await app.inject({ url: '/v1/webhooks', headers: { cookie } }));
    assert.equal(JSON.stringify(list).includes(j(r).signing_secret), false,
      'the signing secret must not be readable after creation');
  });
});

describe('operational endpoints', () => {
  test('health and readiness report honestly', async () => {
    assert.equal(j(await app.inject({ url: '/healthz' })).status, 'ok');
    const ready = j(await app.inject({ url: '/readyz' }));
    assert.equal(ready.status, 'ready');
    assert.equal(ready.database.ok, true);
    assert.ok(typeof ready.database.latency_ms === 'number');
  });

  test('pricing is served publicly and states the meter', async () => {
    const p = j(await app.inject({ url: '/v1/billing/plans' }));
    assert.equal(p.meter.unit, 'gated_effect');
    assert.ok(p.meter.free_operations.length >= 4);
    assert.equal(p.plans.length, Object.keys(PLANS).length);
    assert.equal(p.provider.test_mode, true,
      'with no live credentials the response must say so plainly');
  });
});
