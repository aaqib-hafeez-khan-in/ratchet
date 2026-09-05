// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-to-pass-checks';
process.env.DATABASE_URL = 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet_test';

const { verifyStripeSignature } = await import('../../src/domain/billing.js');

const SECRET = 'whsec_testsecret';
const sign = (payload: string, t: number, secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

describe('payment webhook signature verification', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const now = 1_700_000_000_000;
  const t = Math.floor(now / 1000);

  test('accepts a correctly signed, fresh payload', () => {
    assert.equal(verifyStripeSignature(payload, sign(payload, t), SECRET, 300, now), true);
  });

  test('rejects a tampered payload', () => {
    const header = sign(payload, t);
    assert.equal(verifyStripeSignature(payload + 'x', header, SECRET, 300, now), false);
  });

  test('rejects a signature made with the wrong secret', () => {
    assert.equal(verifyStripeSignature(payload, sign(payload, t, 'whsec_other'), SECRET, 300, now), false);
  });

  test('rejects a replayed payload outside the tolerance window', () => {
    const old = t - 3600;
    assert.equal(verifyStripeSignature(payload, sign(payload, old), SECRET, 300, now), false);
  });

  test('rejects malformed or absent headers', () => {
    for (const h of ['', 'garbage', 't=abc,v1=def', `t=${t}`, `v1=deadbeef`]) {
      assert.equal(verifyStripeSignature(payload, h, SECRET, 300, now), false, `header: ${h}`);
    }
  });

  test('rejects everything when no secret is configured', () => {
    assert.equal(verifyStripeSignature(payload, sign(payload, t), '', 300, now), false);
  });
});
