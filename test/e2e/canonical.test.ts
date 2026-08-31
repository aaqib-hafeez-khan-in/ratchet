/**
 * Moving to a real domain introduces two ways to break things quietly: a
 * redirect that mangles an API call, and a security.txt that silently expires.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../helpers.js';

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

describe('security.txt', () => {
  test('is served and cannot be stale', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'] as string, /text\/plain/);

    const expires = /^Expires: (.+)$/m.exec(r.body)?.[1];
    assert.ok(expires, 'RFC 9116 requires an Expires field');
    const days = (Date.parse(expires) - Date.now()) / 86_400_000;
    assert.ok(days > 30, `expires in ${Math.round(days)} days — too soon to be useful`);
    assert.ok(days < 366, 'RFC 9116 discourages an Expires more than a year out');
    assert.match(r.body, /^Contact: mailto:security@/m);
  });
});

describe('canonical host redirect', () => {
  // In test the app is not in production mode, so the hook is inert. What
  // matters is that API paths are excluded from the rule regardless.
  test('API paths are never redirected', async () => {
    for (const url of ['/healthz', '/openapi.json', '/llms.txt',
                       '/.well-known/agent-manifest.json', '/v1/integrate']) {
      const r = await app.inject({ method: 'GET', url, headers: { host: 'old.example' } });
      assert.notEqual(r.statusCode, 301, `${url} must not be redirected`);
    }
  });

  test('a POST is never redirected, whatever the host', async () => {
    // A 301 on a POST is downgraded to GET by some clients, which would turn a
    // gated begin into a page fetch and hand back a decision nobody made.
    const r = await app.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: { host: 'old.example', 'content-type': 'application/json' },
      payload: { effect_type: 'email.send', idempotency_key: 'x', payload: {} } });
    assert.notEqual(r.statusCode, 301);
  });
});
