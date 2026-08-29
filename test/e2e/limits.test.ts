import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_PER_MINUTE = '5';
const { setupDb, closePool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let keyA: string;
let keyB: string;

before(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.ready();
  keyA = (await createWorkspace('Limit A', 'la@example.test', false)).key.plaintext;
  keyB = (await createWorkspace('Limit B', 'lb@example.test', false)).key.plaintext;
});
after(async () => { await app.close(); await closePool(); });

const hit = (key: string) =>
  app.inject({ url: '/v1/effects', headers: { authorization: `Bearer ${key}` } });

describe('rate limiting', () => {
  test('a key is throttled once it exceeds its window', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await hit(keyA)).statusCode);
    assert.equal(codes.filter((c) => c === 200).length, 5);
    assert.ok(codes.includes(429), 'the limit must actually be enforced');
  });

  test('the throttle response is machine-readable and says when to retry', async () => {
    const r = await hit(keyA);
    assert.equal(r.statusCode, 429);
    const body = JSON.parse(r.payload);
    assert.equal(body.error.code, 'rate_limited');
    assert.ok(body.error.detail.retry_after_seconds > 0);
  });

  test('one tenant cannot exhaust another tenant\'s budget', async () => {
    // Key A is already throttled; key B must be unaffected.
    const r = await hit(keyB);
    assert.equal(r.statusCode, 200,
      'limits are per-key, so a noisy tenant must not throttle a quiet one');
  });

  test('signup is throttled separately and more tightly than the API', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push((await app.inject({
        method: 'POST', url: '/v1/workspaces',
        payload: { name: `Spam ${i}`, email: `spam${i}@example.test` },
      })).statusCode);
    }
    assert.ok(codes.includes(429), 'unauthenticated signup must be rate limited');
    assert.ok(codes.filter((c) => c === 201).length <= 5);
  });
});

describe('request size limits', () => {
  test('an oversized body is refused before it is parsed', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { authorization: `Bearer ${keyB}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        effect_type: 'email.send', idempotency_key: 'big',
        payload: { blob: 'x'.repeat(200_000) },
      }),
    });
    assert.ok(r.statusCode === 413 || r.statusCode === 429, `got ${r.statusCode}`);
  });
});
