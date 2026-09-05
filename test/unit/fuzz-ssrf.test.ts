// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK = 'false';
process.env.WEBHOOK_HOST_ALLOWLIST = '';

const { validateWebhookUrl, isPrivateAddress, UnsafeUrlError } =
  await import('../../src/lib/ssrf.js');

/**
 * Property-based fuzzing of the SSRF guard.
 *
 * The example tests cover the bypasses somebody already thought of. These cover
 * the shape of the guarantee: whatever string arrives, the function either
 * refuses it with an UnsafeUrlError or returns a URL that satisfies every rule
 * it claims to enforce. A third outcome — a TypeError from the URL parser, a
 * RangeError from a hostile hostname — is a crash in the request path, and an
 * unhandled crash reached by an attacker-supplied string is a denial of service
 * whether or not it also leaks anything.
 *
 * The static check is deliberately only half the guard: DNS is re-resolved and
 * the socket pinned at delivery time. So these assert what validateWebhookUrl
 * actually promises, not what the pair promises together.
 */

const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);

/** Strings shaped like the things people actually try. */
const hostileUrl = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.webUrl(),
  // Encodings of 127.0.0.1 that are not spelled 127.0.0.1
  fc.constantFrom(
    'http://2130706433/', 'https://2130706433/', 'https://0x7f000001/',
    'https://0177.0.0.1/', 'https://127.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://localhost/', 'https://LOCALHOST./', 'https://169.254.169.254/latest/meta-data/',
    'https://user:pass@example.com/', 'https://example.com:22/', 'https://example.com:0/',
    'http://example.com/', 'file:///etc/passwd', 'gopher://example.com/',
    'https://example.com\t/', 'https://exa\nmple.com/', 'https://例え.テスト/',
    'https://xn--r8jz45g.xn--zckzah/', 'https://example.com.', 'https://[fe80::1]/',
  ),
  // Structured near-misses built from parts
  fc.tuple(
    fc.constantFrom('https:', 'http:', 'ftp:', 'javascript:', 'data:'),
    fc.constantFrom('//', '///', '//user@', '//user:pw@'),
    fc.constantFrom('example.com', '127.0.0.1', '10.0.0.1', '169.254.169.254',
      '[::1]', 'localhost', '0.0.0.0', '100.64.0.1', '::1'),
    fc.constantFrom('', ':80', ':443', ':22', ':8080', ':0', ':99999'),
    fc.constantFrom('', '/', '/path', '/?q=1', '/#frag'),
  ).map(([s, a, h, p, t]) => `${s}${a}${h}${p}${t}`),
);

describe('SSRF guard: properties for every string a caller can send', () => {
  test('it either refuses with UnsafeUrlError or returns — it never crashes', () => {
    fc.assert(fc.property(hostileUrl, (raw) => {
      try {
        validateWebhookUrl(raw);
      } catch (err) {
        assert.ok(err instanceof UnsafeUrlError,
          `${JSON.stringify(raw)} threw ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
      }
    }), { numRuns: RUNS });
  });

  test('anything it accepts satisfies every rule it advertises', () => {
    fc.assert(fc.property(hostileUrl, (raw) => {
      let url: URL;
      try { url = validateWebhookUrl(raw); } catch { return; }

      assert.equal(url.protocol, 'https:', `accepted non-https: ${raw}`);
      assert.equal(url.username, '', `accepted embedded username: ${raw}`);
      assert.equal(url.password, '', `accepted embedded password: ${raw}`);

      const port = url.port ? Number.parseInt(url.port, 10) : 443;
      assert.ok(port === 80 || port === 443, `accepted port ${port}: ${raw}`);

      // A literal IP bypasses the allowlist, so the static check must refuse it
      // and leave the address question to the pinned re-resolution.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const isLiteral = /^[0-9.]+$/.test(host) && host.split('.').length === 4
        ? host.split('.').every((o) => o !== '' && Number(o) >= 0 && Number(o) <= 255)
        : host.includes(':');
      assert.ok(!isLiteral, `accepted an IP literal host ${host}: ${raw}`);
    }), { numRuns: RUNS });
  });
});

describe('address classification: every reserved range is private', () => {
  const octet = fc.integer({ min: 0, max: 255 });

  test('it never throws, on any string', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (s) => { isPrivateAddress(s); }),
      { numRuns: RUNS });
  });

  test('every address inside a blocked v4 range is classified private', () => {
    const inRange = (base: string, bits: number) => fc.tuple(octet, octet, octet, octet)
      .map((rand) => {
        const b = base.split('.').map(Number);
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        const baseInt = ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
        const randInt = ((rand[0] << 24) >>> 0) + (rand[1] << 16) + (rand[2] << 8) + rand[3];
        const ip = ((baseInt & mask) | (randInt & ~mask)) >>> 0;
        return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
      });

    for (const [base, bits] of [
      ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.168.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8], ['224.0.0.0', 4],
      ['240.0.0.0', 4], ['198.18.0.0', 15],
    ] as const) {
      fc.assert(fc.property(inRange(base, bits), (ip) => {
        assert.ok(isPrivateAddress(ip), `${ip} is inside ${base}/${bits} but was allowed`);
      }), { numRuns: 400 });
    }
  });

  test('the cloud metadata address is private however it is spelled', () => {
    for (const form of ['169.254.169.254', '::ffff:169.254.169.254']) {
      assert.ok(isPrivateAddress(form), `${form} was allowed`);
    }
  });

  test('a malformed dotted quad is treated as private, not as public', () => {
    // v4ToInt returns -1 for anything it cannot parse, and the guard must fail
    // closed on that rather than letting an unparseable host through.
    fc.assert(fc.property(
      fc.string({ unit: 'binary' }),
      (s) => {
        const looksV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
        if (!looksV4) return;
        const bad = s.split('.').some((o) => Number(o) > 255);
        if (bad) assert.ok(isPrivateAddress(s), `${s} is not a valid v4 but was allowed`);
      }), { numRuns: RUNS });
  });
});
