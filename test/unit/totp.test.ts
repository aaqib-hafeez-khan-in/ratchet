// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { totp, hotp, verifyTotp, base32Encode, base32Decode, newSecret, otpauthUri }
  from '../../src/lib/totp.js';

/**
 * Checked against the published test vectors, not against itself.
 *
 * A TOTP implementation that is subtly wrong still returns six plausible
 * digits. Nothing about the output looks incorrect; you discover the mistake
 * when a customer cannot get into their account, or — worse — when a code that
 * should have expired is still accepted. So the assertions below are RFC 4226
 * Appendix D and RFC 6238 Appendix B verbatim, and the implementation is only
 * trustworthy to the extent it reproduces them.
 */

// RFC 4226 uses the ASCII secret "12345678901234567890".
const RFC_SECRET_ASCII = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET_ASCII);

describe('base32 round-trips, because everything else depends on it', () => {
  test('the RFC secret encodes to the documented value', () => {
    assert.equal(RFC_SECRET_B32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  test('decode undoes encode for arbitrary bytes', () => {
    for (let n = 1; n <= 40; n++) {
      const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
      assert.deepEqual(base32Decode(base32Encode(buf)), buf, `length ${n}`);
    }
  });

  test('it refuses input that is not base32', () => {
    assert.throws(() => base32Decode('ABC!DEF'), /not base32/);
  });
});

describe('HOTP matches RFC 4226 Appendix D', () => {
  // counter -> expected 6-digit code
  const VECTORS = [
    [0, '755224'], [1, '287082'], [2, '359152'], [3, '969429'], [4, '338314'],
    [5, '254676'], [6, '287922'], [7, '162583'], [8, '399871'], [9, '520489'],
  ] as const;

  for (const [counter, expected] of VECTORS) {
    test(`counter ${counter} -> ${expected}`, () => {
      assert.equal(hotp(RFC_SECRET_ASCII, counter), expected);
    });
  }
});

describe('TOTP matches RFC 6238 Appendix B', () => {
  // The RFC's SHA-1 vectors are 8 digits. Its 20-byte seed is the same one.
  const VECTORS = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ] as const;

  for (const [seconds, expected] of VECTORS) {
    test(`T=${seconds} -> ${expected}`, () => {
      assert.equal(
        totp(RFC_SECRET_B32, seconds * 1000, { digits: 8, algorithm: 'sha1' }),
        expected,
        'this is the vector the whole implementation rests on',
      );
    });
  }

  test('no RFC vector reaches the high half of the counter — so this does', () => {
    // Worth being exact about, because it is easy to believe otherwise: the
    // largest published vector is T=20000000000 seconds, which is a counter of
    // 666,666,666 — comfortably below 2^32. Every RFC vector therefore has a
    // zero high word, and an implementation that wrote a hard 0 there passes
    // all of them. Confirmed by deliberately introducing that bug: 28 of 28
    // still passed.
    assert.ok(Math.floor(20000000000 / 30) < 0x100000000,
      'if this ever fails, the vectors do cover the high word and this test can go');

    // Counters that differ only above 2^32 must produce different codes.
    const low = hotp(RFC_SECRET_ASCII, 1);
    const high = hotp(RFC_SECRET_ASCII, 0x100000000 + 1);
    assert.notEqual(high, low,
      'the counter high word is being dropped: 2^32+1 is hashing as 1');
  });
});

describe('verification', () => {
  const secret = newSecret();
  const now = 1_700_000_000_000;

  test('the current code verifies', () => {
    assert.equal(verifyTotp(secret, totp(secret, now), { atMs: now }), true);
  });

  test('the previous and next step verify, for clock drift', () => {
    assert.equal(verifyTotp(secret, totp(secret, now - 30_000), { atMs: now }), true);
    assert.equal(verifyTotp(secret, totp(secret, now + 30_000), { atMs: now }), true);
  });

  test('two steps away does not', () => {
    assert.equal(verifyTotp(secret, totp(secret, now - 90_000), { atMs: now }), false);
    assert.equal(verifyTotp(secret, totp(secret, now + 90_000), { atMs: now }), false);
  });

  test('a code for a different secret never verifies', () => {
    const other = newSecret();
    assert.equal(verifyTotp(secret, totp(other, now), { atMs: now }), false);
  });

  test('malformed input is refused rather than throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ', '000000x']) {
      assert.equal(typeof verifyTotp(secret, bad, { atMs: now }), 'boolean', bad);
    }
    assert.equal(verifyTotp(secret, '', { atMs: now }), false);
  });

  test('a secret is at least the 20 bytes RFC 4226 requires', () => {
    assert.ok(base32Decode(newSecret()).length >= 20);
  });

  test('two secrets are never the same', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newSecret()));
    assert.equal(seen.size, 200);
  });
});

describe('the enrolment URI', () => {
  test('carries what an authenticator app needs', () => {
    const uri = otpauthUri('GEZDGNBVGY3TQOJQ', 'ops@example.test', 'Ratchet');
    const u = new URL(uri);
    assert.equal(u.protocol, 'otpauth:');
    assert.equal(u.searchParams.get('secret'), 'GEZDGNBVGY3TQOJQ');
    assert.equal(u.searchParams.get('issuer'), 'Ratchet');
    assert.equal(u.searchParams.get('digits'), '6');
    assert.equal(u.searchParams.get('period'), '30');
    assert.match(decodeURIComponent(u.pathname), /Ratchet:ops@example\.test/);
  });
});
