// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { canonicalize, canonicalFingerprint } from '../../src/lib/ids.js';

/**
 * Property-based fuzzing of the payload fingerprint.
 *
 * This function decides whether two `begin` calls describe the same real-world
 * action. Every example-based test here asserts something a human thought of;
 * these assert what must hold for every payload a caller can send, which is the
 * set that actually reaches production.
 *
 * The consequences are asymmetric and both bad. If two DIFFERENT payloads
 * fingerprint the same, a caller reusing an idempotency key with new arguments
 * is told "duplicate" and the second action silently never happens. If the SAME
 * payload fingerprints differently across two calls — key order, unicode form —
 * the gate authorises the same real-world effect twice, which is the one thing
 * this service exists to prevent.
 */

/** Arbitrary JSON, the shape a payload actually takes on the wire. */
const json = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer(),
    fc.string({ unit: 'binary' }),
    fc.array(tie('value'), { maxLength: 6 }),
    fc.dictionary(fc.string({ unit: 'binary' }), tie('value'), { maxKeys: 6 }),
  ),
})).value;

const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);

describe('fingerprint: properties that must hold for every payload', () => {
  test('it never throws, whatever it is handed', () => {
    fc.assert(fc.property(json, (v) => { canonicalFingerprint(v); }), { numRuns: RUNS });
  });

  test('it is deterministic', () => {
    fc.assert(fc.property(json, (v) => {
      assert.equal(
        canonicalFingerprint(v).toString('hex'),
        canonicalFingerprint(v).toString('hex'),
      );
    }), { numRuns: RUNS });
  });

  test('key order never changes the fingerprint', () => {
    // The property the whole idempotency contract rests on: two JSON encoders
    // that disagree about key order must not produce two different effects.
    fc.assert(fc.property(
      fc.dictionary(fc.string({ unit: 'binary' }), json, { minKeys: 2, maxKeys: 8 }),
      (obj) => {
        const shuffled = Object.fromEntries(Object.entries(obj).reverse());
        assert.equal(
          canonicalFingerprint(obj).toString('hex'),
          canonicalFingerprint(shuffled).toString('hex'),
        );
      }), { numRuns: RUNS });
  });

  test('a round trip through JSON does not move the fingerprint', () => {
    fc.assert(fc.property(json, (v) => {
      const before = canonicalFingerprint(v).toString('hex');
      const after = canonicalFingerprint(JSON.parse(JSON.stringify(v))).toString('hex');
      assert.equal(after, before);
    }), { numRuns: RUNS });
  });

  test('distinct canonical forms produce distinct digests', () => {
    // Collision hunting. Two payloads that canonicalise differently must not
    // land on one fingerprint: that is a different action treated as a replay.
    const seen = new Map<string, string>();
    fc.assert(fc.property(json, (v) => {
      const canon = canonicalize(v);
      const digest = canonicalFingerprint(v).toString('hex');
      const prior = seen.get(digest);
      if (prior !== undefined) {
        assert.equal(prior, canon,
          `two different canonical forms share a digest:\n  ${prior}\n  ${canon}`);
      }
      seen.set(digest, canon);
    }), { numRuns: RUNS });
  });

  test('a structural change always changes the canonical form', () => {
    // Nesting must be visible to the hash: {a:{b:1}} and {"a.b":1} are not the
    // same request, however similar their flattened text looks.
    fc.assert(fc.property(
      fc.string({ unit: 'binary', minLength: 1 }),
      fc.string({ unit: 'binary', minLength: 1 }),
      json,
      (outer, inner, leaf) => {
        const nested = { [outer]: { [inner]: leaf } };
        const flat = { [`${outer}.${inner}`]: leaf };
        assert.notEqual(canonicalize(nested), canonicalize(flat));
      }), { numRuns: RUNS });
  });
});
