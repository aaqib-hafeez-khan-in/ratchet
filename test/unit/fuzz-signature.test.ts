import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { verifyStripeSignature } from '../../src/domain/billing.js';

/**
 * Property-based fuzzing of payment webhook signature verification.
 *
 * This function is the whole boundary between "the payment provider said this"
 * and "a stranger posted this to our endpoint". It parses an attacker-supplied
 * header before it has verified anything, which is exactly the position where
 * a crash or a lenient parse costs the most.
 *
 * Two properties matter and they pull in opposite directions. It must never
 * return true for a signature the holder of the secret did not produce — that
 * is forged credit. And it must never throw on a malformed header — that is an
 * unauthenticated denial of service on the billing endpoint.
 */

const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);
const SECRET = 'whsec_test_only_not_a_real_secret';
const NOW = 1_700_000_000_000;

const sign = (payload: string, secret = SECRET, at = Math.floor(NOW / 1000)) => {
  const v1 = createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
  return `t=${at},v1=${v1}`;
};

/** Headers shaped like the things an attacker sends. */
const hostileHeader = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '', ',', '=', 't=', 'v1=', 't=,v1=', 't=abc,v1=def', 't=1,v1=',
    't=1700000000', 'v1=00', 't=1700000000,v1=zz', 't=1e9,v1=00',
    't=1700000000,v1=' + 'a'.repeat(64), 't=1700000000,v1=' + 'a'.repeat(63),
    't=-1700000000,v1=00', 't=1700000000,v1=00,v1=11', 't==,v1==',
    'T=1700000000,V1=00', ' t = 1700000000 , v1 = 00 ',
    't=1700000000,v1=' + '0'.repeat(128), 't=Infinity,v1=00', 't=NaN,v1=00',
  ),
  fc.tuple(
    fc.oneof(fc.integer(), fc.constantFrom('abc', '', 'Infinity', 'NaN', '1e9')),
    fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), maxLength: 80 }),
  ).map(([t, v1]) => `t=${t},v1=${v1}`),
);

describe('payment signature: properties for every header an attacker can post', () => {
  test('it never throws, whatever the header, payload or secret', () => {
    fc.assert(fc.property(
      fc.string({ unit: 'binary' }), hostileHeader, fc.string(),
      (payload, header, secret) => {
        const out = verifyStripeSignature(payload, header, secret, 300, NOW);
        assert.equal(typeof out, 'boolean');
      }), { numRuns: RUNS });
  });

  test('it never accepts a header not produced with the secret', () => {
    fc.assert(fc.property(
      fc.string({ unit: 'binary' }), hostileHeader,
      (payload, header) => {
        assert.equal(verifyStripeSignature(payload, header, SECRET, 300, NOW), false,
          `forged header accepted: ${JSON.stringify(header)}`);
      }), { numRuns: RUNS });
  });

  test('a signature made with a different secret is never accepted', () => {
    fc.assert(fc.property(
      fc.string({ unit: 'binary' }),
      fc.string({ minLength: 1 }).filter((s) => s !== SECRET),
      (payload, wrongSecret) => {
        assert.equal(
          verifyStripeSignature(payload, sign(payload, wrongSecret), SECRET, 300, NOW),
          false, 'a signature from the wrong secret was accepted');
      }), { numRuns: RUNS });
  });

  test('a genuine signature is accepted, for any payload', () => {
    // The other direction: a verifier that refuses everything would pass every
    // test above and reject every real payment.
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (payload) => {
      assert.equal(verifyStripeSignature(payload, sign(payload), SECRET, 300, NOW), true,
        'a correctly signed payload was rejected');
    }), { numRuns: RUNS });
  });

  test('a genuine signature for a DIFFERENT payload is refused', () => {
    fc.assert(fc.property(
      fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }),
      (a, b) => {
        fc.pre(a !== b);
        assert.equal(verifyStripeSignature(a, sign(b), SECRET, 300, NOW), false,
          'a signature bound to another payload was accepted');
      }), { numRuns: RUNS });
  });

  test('a genuine signature outside the replay window is refused', () => {
    fc.assert(fc.property(
      fc.string({ unit: 'binary' }),
      fc.integer({ min: 301, max: 10_000_000 }),
      (payload, drift) => {
        const old = sign(payload, SECRET, Math.floor(NOW / 1000) - drift);
        const future = sign(payload, SECRET, Math.floor(NOW / 1000) + drift);
        assert.equal(verifyStripeSignature(payload, old, SECRET, 300, NOW), false,
          'a replayed signature was accepted');
        assert.equal(verifyStripeSignature(payload, future, SECRET, 300, NOW), false,
          'a future-dated signature was accepted');
      }), { numRuns: RUNS });
  });
});
