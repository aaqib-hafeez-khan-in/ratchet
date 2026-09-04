// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-to-pass-checks';
process.env.DATABASE_URL = 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet_test';

const { signPayload } = await import('../../src/worker/webhooks.js');

describe('outbound webhook signing', () => {
  test('binds timestamp, delivery id, and body together', () => {
    const sig = signPayload('secret', 1700, 'whd_1', '{"a":1}');
    const expected = createHmac('sha256', 'secret').update('1700.whd_1.{"a":1}').digest('hex');
    assert.equal(sig, expected);
  });

  test('a receiver replaying one delivery id under another cannot match', () => {
    const a = signPayload('secret', 1700, 'whd_1', '{"a":1}');
    const b = signPayload('secret', 1700, 'whd_2', '{"a":1}');
    assert.notEqual(a, b);
  });

  test('a changed body changes the signature', () => {
    assert.notEqual(
      signPayload('secret', 1700, 'whd_1', '{"a":1}'),
      signPayload('secret', 1700, 'whd_1', '{"a":2}'),
    );
  });
});
