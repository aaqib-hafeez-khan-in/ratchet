// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, canonicalFingerprint } from '../../src/lib/ids.js';

describe('payload fingerprinting', () => {
  test('key order does not change the fingerprint', () => {
    const a = canonicalFingerprint({ b: 2, a: 1, c: { y: 2, x: 1 } });
    const b = canonicalFingerprint({ a: 1, c: { x: 1, y: 2 }, b: 2 });
    assert.deepEqual(a, b);
  });

  test('different values produce different fingerprints', () => {
    assert.notDeepEqual(
      canonicalFingerprint({ to: 'a@b.com' }),
      canonicalFingerprint({ to: 'attacker@evil.com' }),
    );
  });

  test('array order is significant', () => {
    assert.notDeepEqual(canonicalFingerprint([1, 2]), canonicalFingerprint([2, 1]));
  });

  test('undefined members are dropped, null is preserved', () => {
    assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
    assert.notEqual(canonicalize({ a: null }), canonicalize({}));
  });

  test('non-finite numbers do not break canonicalization', () => {
    assert.equal(canonicalize({ n: NaN }), '{"n":null}');
    assert.equal(canonicalize({ n: Infinity }), '{"n":null}');
  });
});
