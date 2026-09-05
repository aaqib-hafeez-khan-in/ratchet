// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace, createConsoleSession } = await import('../../src/domain/auth.js');
const { totp } = await import('../../src/lib/totp.js');
const { config } = await import('../../src/lib/config.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

let n = 0;
async function operator() {
  const label = `mfa-${n++}-${Date.now()}`;
  const ws = await createWorkspace(label, `${label}@example.test`, false);
  await getPool().query('UPDATE workspaces SET owner_email = $2 WHERE id = $1',
    [ws.workspaceId, `${label}@example.test`]);
  const raw = await createConsoleSession(ws.workspaceId, `${label}@example.test`);
  return { ws, cookie: `rk_session=${raw}` };
}

/** Changing a policy: the archetypal operator action. */
const CHANGE_POLICY = {
  method: 'PUT' as const,
  url: '/v1/policies/payment.charge',
  payload: { mode: 'deny' },
};

describe('a second factor gates the action, not the door', () => {
  test('with MFA off, nothing changes', async () => {
    const { cookie } = await operator();
    const r = await app.inject({ ...CHANGE_POLICY, headers: { cookie } });
    assert.equal(r.statusCode, 200, 'MFA off must not affect anybody');
  });

  test('reading is never gated, even with MFA on', async () => {
    const { ws, cookie } = await operator();
    const e = await app.inject({ method: 'POST', url: '/v1/console/mfa/enrol', headers: { cookie } });
    const { secret } = JSON.parse(e.payload) as { secret: string };
    await app.inject({ method: 'POST', url: '/v1/console/mfa/activate',
      headers: { cookie }, payload: { code: totp(secret) } });

    const r = await app.inject({ method: 'GET', url: '/v1/effects?limit=5', headers: { cookie } });
    assert.equal(r.statusCode, 200,
      'gating reads would make the console unusable and protect nothing');
    assert.ok(ws.workspaceId);
  });

  test('with MFA on, an operator action is refused until a code is presented', async () => {
    const { cookie } = await operator();
    const e = await app.inject({ method: 'POST', url: '/v1/console/mfa/enrol', headers: { cookie } });
    const { secret } = JSON.parse(e.payload) as { secret: string };
    await app.inject({ method: 'POST', url: '/v1/console/mfa/activate',
      headers: { cookie }, payload: { code: totp(secret) } });

    const blocked = await app.inject({ ...CHANGE_POLICY, headers: { cookie } });
    assert.equal(blocked.statusCode, 403);
    const body = JSON.parse(blocked.payload) as { error: { detail?: { mfa_required?: boolean } } };
    assert.equal(body.error.detail?.mfa_required, true,
      'the client needs to know this is a step-up, not a scope problem');

    const v = await app.inject({ method: 'POST', url: '/v1/console/mfa/verify',
      headers: { cookie }, payload: { code: totp(secret) } });
    assert.equal(v.statusCode, 200);

    const allowed = await app.inject({ ...CHANGE_POLICY, headers: { cookie } });
    assert.equal(allowed.statusCode, 200, 'after verifying, the same action must go through');
  });

  test('elevating one session does not elevate another', async () => {
    const { ws, cookie } = await operator();
    const e = await app.inject({ method: 'POST', url: '/v1/console/mfa/enrol', headers: { cookie } });
    const { secret } = JSON.parse(e.payload) as { secret: string };
    await app.inject({ method: 'POST', url: '/v1/console/mfa/activate',
      headers: { cookie }, payload: { code: totp(secret) } });
    await app.inject({ method: 'POST', url: '/v1/console/mfa/verify',
      headers: { cookie }, payload: { code: totp(secret) } });

    const other = `rk_session=${await createConsoleSession(ws.workspaceId, 'other@example.test')}`;
    const r = await app.inject({ ...CHANGE_POLICY, headers: { cookie: other } });
    assert.equal(r.statusCode, 403,
      'a second browser must not inherit the step-up of the first');
  });

  test('every gated route is gated, not just the one I remembered', async () => {
    const { cookie } = await operator();
    const e = await app.inject({ method: 'POST', url: '/v1/console/mfa/enrol', headers: { cookie } });
    const { secret } = JSON.parse(e.payload) as { secret: string };
    await app.inject({ method: 'POST', url: '/v1/console/mfa/activate',
      headers: { cookie }, payload: { code: totp(secret) } });

    const operatorActions = [
      { method: 'POST' as const, url: '/v1/keys', payload: { name: 'k', scopes: ['effects:begin'] } },
      { method: 'PUT' as const, url: '/v1/policies/email.send', payload: { mode: 'deny' } },
      { method: 'DELETE' as const, url: '/v1/policies/email.send' },
      { method: 'POST' as const, url: '/v1/circuits/*/open', payload: { action: 'deny', reason: 'x' } },
      { method: 'POST' as const, url: '/v1/webhooks',
        payload: { url: 'https://hooks.example.com/x', events: ['effect.indeterminate'] } },
    ];
    for (const a of operatorActions) {
      const r = await app.inject({ ...a, headers: { cookie } });
      assert.equal(r.statusCode, 403, `${a.method} ${a.url} was not gated`);
    }
  });

  test('an API key is not asked for a code — it has no session to elevate', async () => {
    const { ws, cookie } = await operator();
    const e = await app.inject({ method: 'POST', url: '/v1/console/mfa/enrol', headers: { cookie } });
    const { secret } = JSON.parse(e.payload) as { secret: string };
    await app.inject({ method: 'POST', url: '/v1/console/mfa/activate',
      headers: { cookie }, payload: { code: totp(secret) } });

    const r = await app.inject({ ...CHANGE_POLICY,
      headers: { authorization: `Bearer ${ws.key.plaintext}` } });
    assert.equal(r.statusCode, 200,
      'a key is a separate credential with its own scopes; an agent cannot type a code');
  });
});

describe('enrolment cannot lock you out', () => {
  test('enrol and verify are reachable without a code', async () => {
    const { cookie } = await operator();
    const e = await app.inject({ method: 'POST', url: '/v1/console/mfa/enrol', headers: { cookie } });
    assert.equal(e.statusCode, 200);
    const { secret } = JSON.parse(e.payload) as { secret: string };
    await app.inject({ method: 'POST', url: '/v1/console/mfa/activate',
      headers: { cookie }, payload: { code: totp(secret) } });

    // Still reachable once enabled, or presenting a code would be impossible.
    const v = await app.inject({ method: 'POST', url: '/v1/console/mfa/verify',
      headers: { cookie }, payload: { code: totp(secret) } });
    assert.equal(v.statusCode, 200);
  });

  test('the secret never appears in the state endpoint', async () => {
    const { cookie } = await operator();
    const e = await app.inject({ method: 'POST', url: '/v1/console/mfa/enrol', headers: { cookie } });
    const { secret } = JSON.parse(e.payload) as { secret: string };
    await app.inject({ method: 'POST', url: '/v1/console/mfa/activate',
      headers: { cookie }, payload: { code: totp(secret) } });

    const s = await app.inject({ method: 'GET', url: '/v1/console/mfa', headers: { cookie } });
    assert.equal(s.statusCode, 200);
    assert.ok(!s.payload.includes(secret), 'the shared secret must be returned once, at enrolment');
    const body = JSON.parse(s.payload) as Record<string, unknown>;
    assert.equal(body.enabled, true);
    assert.equal(body.recovery_codes_remaining, 10);
  });
});
