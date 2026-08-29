import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-to-pass-checks';
process.env.DATABASE_URL = 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet_test';

const { isPrivateAddress } = await import('../../src/lib/ssrf.js');

describe('SSRF address classification', () => {
  test('rejects loopback, private, link-local, and metadata addresses', () => {
    const blocked = [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.254',
      '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.168.0.0',
      '169.254.169.254',            // cloud instance metadata
      '100.64.0.1',                 // carrier-grade NAT
      '198.18.0.1', '224.0.0.1', '240.0.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
      '::ffff:127.0.0.1',           // IPv4-mapped loopback
      '::ffff:10.0.0.1',
      'not-an-ip',
    ];
    for (const a of blocked) {
      assert.equal(isPrivateAddress(a), true, `${a} must be treated as private`);
    }
  });

  test('permits ordinary public addresses', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1',
                     '172.15.255.255', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(a), false, `${a} must be treated as public`);
    }
  });

  test('boundaries of the private ranges are exact', () => {
    assert.equal(isPrivateAddress('172.15.255.255'), false); // just below 172.16/12
    assert.equal(isPrivateAddress('172.16.0.0'), true);
    assert.equal(isPrivateAddress('172.31.255.255'), true);
    assert.equal(isPrivateAddress('172.32.0.0'), false);     // just above
    assert.equal(isPrivateAddress('9.255.255.255'), false);
    assert.equal(isPrivateAddress('11.0.0.0'), false);
  });
});

describe('webhook URL validation', () => {
  test('rejects unsafe URLs when private networking is off', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK = 'false';
    const mod = await import(`../../src/lib/ssrf.js?strict=${Date.now()}`);
    const { validateWebhookUrl, UnsafeUrlError } = mod;

    const bad: Array<[string, string]> = [
      ['http://example.com/hook', 'plain http'],
      ['https://user:pw@example.com/hook', 'embedded credentials'],
      ['https://192.168.1.1/hook', 'IP literal'],
      ['https://example.com:22/hook', 'non-web port'],
      ['file:///etc/passwd', 'non-http scheme'],
      ['gopher://example.com/', 'non-http scheme'],
      ['not a url', 'unparseable'],
    ];
    for (const [url, why] of bad) {
      assert.throws(() => validateWebhookUrl(url), UnsafeUrlError, `should reject ${why}: ${url}`);
    }
    assert.ok(validateWebhookUrl('https://hooks.example.com/ingest'));
    assert.ok(validateWebhookUrl('https://example.com:443/ingest'));
  });
});
