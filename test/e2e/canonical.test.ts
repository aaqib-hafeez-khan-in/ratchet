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

  // The security page claimed this build shipped no contact address long after
  // security.txt started publishing one, which tells a researcher there is
  // nowhere to report. Drift between the two is the failure worth catching.
  test('the security page offers the contact security.txt promises', async () => {
    const txt = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    const mailbox = /^Contact: mailto:([^@\s]+)@/m.exec(txt.body)?.[1];
    assert.ok(mailbox, 'security.txt must publish a contact');

    // Only the mailbox is compared. security.txt takes its host from config, so
    // it is security@localhost in test, while the page is a static marketing
    // asset that names the real domain. The drift that matters is a page that
    // sends a researcher nowhere, not a hostname that differs by environment.
    const page = await app.inject({ method: 'GET', url: '/security' });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(`mailto:${mailbox}@`),
      `the security page offers no mailto:${mailbox}@ address`);
    assert.doesNotMatch(page.body, /ships no contact address/,
      'the security page still denies having a contact address');
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

describe('notes section', () => {
  // Renamed from /blog on 31 August 2026. The article was already published at
  // the old path, so the redirects are part of the contract, not tidy-up.
  test('serves the notes index and the article', async () => {
    for (const url of ['/notes', '/notes/idempotency-keys-are-broken-on-macos']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, `${url} should be served`);
    }
  });

  test('old blog URLs redirect permanently rather than 404', async () => {
    const cases: Array<[string, string]> = [
      ['/blog', '/notes'],
      ['/blog/idempotency-keys-are-broken-on-macos',
       '/notes/idempotency-keys-are-broken-on-macos'],
    ];
    for (const [from, to] of cases) {
      const r = await app.inject({ method: 'GET', url: from });
      assert.equal(r.statusCode, 301, `${from} should be a permanent redirect`);
      assert.equal(r.headers.location, to);
    }
  });

  test('an unknown slug still 404s under either prefix', async () => {
    for (const url of ['/blog/nope', '/notes/nope']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 404, `${url} should not resolve`);
    }
  });

  test('no page still links to the old prefix', async () => {
    for (const url of ['/', '/notes', '/docs', '/pricing']) {
      const r = await app.inject({ method: 'GET', url });
      assert.doesNotMatch(r.body, /href="\/blog/, `${url} links to the old prefix`);
    }
  });
});
