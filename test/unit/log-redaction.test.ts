/**
 * The logger must never emit a credential.
 *
 * CLAUDE.md rule 8 says so and tells you to extend the list whenever a
 * credential header is added — and nothing enforced it. The rule was a comment.
 * That was found while writing ASSURANCE_CASE.md, which cited a test for this
 * claim that did not exist.
 *
 * There is a second, subtler reason to pin it. The request serializer below
 * returns only method, url and id, so headers never reach the log line at all
 * on that path. That makes the redact list look redundant right up until
 * somebody widens the serializer, at which point it is the only thing standing
 * between an Authorization header and a log aggregator.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/api/app.ts', import.meta.url), 'utf8');
const config = (() => {
  const i = app.indexOf('redact:');
  assert.ok(i > -1, 'the logger has no redact configuration at all');
  return app.slice(i, app.indexOf('serializers:', i));
})();

/**
 * Every credential header, and the EXACT redact path each one needs.
 *
 * Substring matching is not good enough here and the first version of this test
 * proved it: removing 'req.headers.cookie' still passed, because
 * 'res.headers["set-cookie"]' contains the word cookie. A test that cannot fail
 * is worse than no test, so each entry names the path it requires.
 */
const CREDENTIAL_HEADERS: [name: string, path: RegExp][] = [
  ['authorization',    /req\.headers\.authorization/],
  ['x-api-key',        /req\.headers\["x-api-key"\]/],
  ['cookie',           /req\.headers\.cookie/],
  ['stripe-signature', /req\.headers\["stripe-signature"\]/],
  ['set-cookie',       /res\.headers\["set-cookie"\]/],
];

describe('no credential header can reach the logs', () => {
  for (const [name, path] of CREDENTIAL_HEADERS) {
    test(`${name} is redacted`, () => {
      assert.match(config, path,
        `${name} carries a credential and its redact path is missing. `
        + 'CLAUDE.md rule 8: extend that list whenever you add a credential header.');
    });
  }

  test('the censor replaces rather than truncates', () => {
    assert.match(config, /censor:\s*'\[redacted\]'/,
      'a truncated secret is still a partial secret');
  });

  test('both request and response headers are covered', () => {
    assert.match(config, /req\.headers/, 'inbound credentials');
    assert.match(config, /res\.headers/, 'the session on the way back out');
  });
});

/**
 * If a new credential header is introduced anywhere in the codebase, this is the
 * test that should fail. It scans for header names that look like credentials
 * and checks each is either redacted or is one we have consciously judged safe.
 */
describe('a newly introduced credential header cannot slip past', () => {
  test('every credential-looking header in src/ is accounted for', () => {
    const src = readFileSync(new URL('../../src/api/app.ts', import.meta.url), 'utf8');
    const known = new Set([...CREDENTIAL_HEADERS.map(([n]) => n),
      'content-type', 'accept', 'user-agent',
      'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
      'strict-transport-security', 'x-content-type-options', 'referrer-policy',
      'x-frame-options', 'permissions-policy', 'mcp-protocol-version']);
    const found = [...src.matchAll(/['"]((?:x-)?[a-z]+(?:-[a-z]+)*)['"]/g)]
      .map((m) => m[1]!)
      // A header name, not any hyphenated string. Blog slugs live in this file
      // too and "idempotency-keys-are-broken-on-macos" is not a header.
      .filter((h) => h.length <= 26 && h.split('-').length <= 3)
      .filter((h) => /key|token|secret|auth|signature|cookie|password|credential/.test(h));
    const unaccounted = [...new Set(found)].filter((h) => !known.has(h));
    assert.deepEqual(unaccounted, [],
      'these look like credential headers and are neither redacted nor known-safe');
  });
});
