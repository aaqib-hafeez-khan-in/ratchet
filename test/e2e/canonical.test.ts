// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Moving to a real domain introduces two ways to break things quietly: a
 * redirect that mangles an API call, and a security.txt that silently expires.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { readFileSync } from 'node:fs';
import { closePool } from '../helpers.js';

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

describe('security.txt', () => {
  test('is served and cannot be stale', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'] as string, /text\/plain/);

    const expires = /^Expires: (.+)$/m.exec(r.body)?.[1];
    assert.ok(expires, 'RFC 9116 requires an Expires field');
    const days = (Date.parse(expires) - Date.now()) / 86_400_000;
    assert.ok(days > 30, `expires in ${Math.round(days)} days — too soon to be useful`);
    assert.ok(days < 366, 'RFC 9116 discourages an Expires more than a year out');
    assert.match(r.body, /^Contact: mailto:security@/m);
  });

  // The security page claimed this build shipped no contact address long after
  // security.txt started publishing one, which tells a researcher there is
  // nowhere to report. Drift between the two is the failure worth catching.
  // Scanners still probe the pre-RFC-9116 root path; Cloudflare's reported
  // "not configured" for a domain that has always served one.
  test('the legacy root path finds it too', async () => {
    const r = await app.inject({ method: 'GET', url: '/security.txt' });
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, '/.well-known/security.txt');
  });

  test('the security page offers the contact security.txt promises', async () => {
    const txt = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    const mailbox = /^Contact: mailto:([^@\s]+)@/m.exec(txt.body)?.[1];
    assert.ok(mailbox, 'security.txt must publish a contact');

    // Only the mailbox is compared. security.txt takes its host from config, so
    // it is security@localhost in test, while the page is a static marketing
    // asset that names the real domain. The drift that matters is a page that
    // sends a researcher nowhere, not a hostname that differs by environment.
    const page = await app.inject({ method: 'GET', url: '/security' });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(`mailto:${mailbox}@`),
      `the security page offers no mailto:${mailbox}@ address`);
    assert.doesNotMatch(page.body, /ships no contact address/,
      'the security page still denies having a contact address');
  });
});

describe('canonical host redirect', () => {
  // In test the app is not in production mode, so the hook is inert. What
  // matters is that API paths are excluded from the rule regardless.
  test('API paths are never redirected', async () => {
    for (const url of ['/healthz', '/openapi.json', '/llms.txt',
                       '/.well-known/agent-manifest.json', '/v1/integrate']) {
      const r = await app.inject({ method: 'GET', url, headers: { host: 'old.example' } });
      assert.notEqual(r.statusCode, 301, `${url} must not be redirected`);
    }
  });

  test('a POST is never redirected, whatever the host', async () => {
    // A 301 on a POST is downgraded to GET by some clients, which would turn a
    // gated begin into a page fetch and hand back a decision nobody made.
    const r = await app.inject({ method: 'POST', url: '/v1/effects/begin',
      headers: { host: 'old.example', 'content-type': 'application/json' },
      payload: { effect_type: 'email.send', idempotency_key: 'x', payload: {} } });
    assert.notEqual(r.statusCode, 301);
  });
});

describe('notes section', () => {
  // Renamed from /blog on 31 August 2026. The article was already published at
  // the old path, so the redirects are part of the contract, not tidy-up.
  test('serves the notes index', async () => {
    const r = await app.inject({ method: 'GET', url: '/notes' });
    assert.equal(r.statusCode, 200);
  });

  // Derived from the sitemap rather than a hard-coded list, so publishing an
  // article and forgetting to route it fails here instead of 404ing in public.
  test('every article the sitemap advertises is actually served', async () => {
    const sitemap = readFileSync(
      new URL('../../web/sitemap.xml', import.meta.url), 'utf8');
    const slugs = [...sitemap.matchAll(/<loc>[^<]*\/notes\/([^<]+)<\/loc>/g)]
      .map((m) => m[1]);
    assert.ok(slugs.length > 0, 'the sitemap should list at least one article');
    for (const slug of slugs) {
      const r = await app.inject({ method: 'GET', url: `/notes/${slug}` });
      assert.equal(r.statusCode, 200, `/notes/${slug} is in the sitemap but 404s`);
    }
  });

  /**
   * The article version of this existed and covered only `/notes/…`. Adding
   * `/status` to the sitemap without routing it would have sailed straight
   * past — a URL advertised to Google that returns 404 is worse than one that
   * was never advertised, because it is a crawl error against the domain.
   */
  test('every page the sitemap advertises is actually served', async () => {
    const sitemap = readFileSync(
      new URL('../../web/sitemap.xml', import.meta.url), 'utf8');
    const paths = [...sitemap.matchAll(/<loc>https:\/\/ratchetgate\.com([^<]*)<\/loc>/g)]
      .map((m) => m[1] || '/');
    assert.ok(paths.length >= 10, 'the sitemap should list the whole public site');

    for (const path of paths) {
      const r = await app.inject({ method: 'GET', url: path });
      assert.equal(r.statusCode, 200, `${path} is in the sitemap but returned ${r.statusCode}`);
    }
  });

  // A status page nobody can find is decoration. It is reachable from every
  // page's footer on purpose.
  test('the status page is served and linked from the footer chrome', async () => {
    const r = await app.inject({ method: 'GET', url: '/status' });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Is the gate up\?/);

    const partials = readFileSync(
      new URL('../../web/assets/partials.js', import.meta.url), 'utf8');
    assert.match(partials, /href="\/status"/,
      'the footer must link the status page, or nobody will find it');
  });

  test('every article the notes index links to is served', async () => {
    const index = await app.inject({ method: 'GET', url: '/notes' });
    const slugs = [...index.body.matchAll(/href="\/notes\/([a-z0-9-]+)"/g)]
      .map((m) => m[1]);
    assert.ok(slugs.length > 0, 'the index should link to at least one article');
    for (const slug of slugs) {
      const r = await app.inject({ method: 'GET', url: `/notes/${slug}` });
      assert.equal(r.statusCode, 200, `the index links to /notes/${slug}, which 404s`);
    }
  });

  test('old blog URLs redirect permanently rather than 404', async () => {
    const cases: Array<[string, string]> = [
      ['/blog', '/notes'],
      ['/blog/idempotency-keys-are-broken-on-macos',
       '/notes/idempotency-keys-are-broken-on-macos'],
    ];
    for (const [from, to] of cases) {
      const r = await app.inject({ method: 'GET', url: from });
      assert.equal(r.statusCode, 301, `${from} should be a permanent redirect`);
      assert.equal(r.headers.location, to);
    }
  });

  test('an unknown slug still 404s under either prefix', async () => {
    for (const url of ['/blog/nope', '/notes/nope']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 404, `${url} should not resolve`);
    }
  });

  test('no page still links to the old prefix', async () => {
    for (const url of ['/', '/notes', '/docs', '/pricing']) {
      const r = await app.inject({ method: 'GET', url });
      assert.doesNotMatch(r.body, /href="\/blog/, `${url} links to the old prefix`);
    }
  });
});

/**
 * Every one of these exists because a user told us something was missing that
 * was not missing. Figma was in the vendor directory for a day before somebody
 * said it was absent — it was absent from the site, not from the product. These
 * assert that the human-readable page exists, not merely the JSON.
 */
describe('the things people could not find', () => {
  test('the vendor directory is a page, not only an endpoint', async () => {
    const page = await app.inject({ method: 'GET', url: '/vendors' });
    assert.equal(page.statusCode, 200);

    const api = await app.inject({ method: 'GET', url: '/v1/vendors' });
    assert.equal(api.statusCode, 200);
    const { vendors } = api.json() as { vendors: Array<{ vendor: string }> };
    assert.ok(vendors.some((v) => v.vendor === 'figma'),
      'figma should be in the directory the page renders');
  });

  // CLAUDE.md §6: the wire is snake_case. This endpoint spread the domain
  // object straight into the response and published `maxLength`.
  test('the vendor endpoint emits no camelCase', async () => {
    for (const url of ['/v1/vendors', '/v1/vendors/stripe']) {
      const r = await app.inject({ method: 'GET', url });
      const seen = JSON.stringify(r.json());
      const keys = [...seen.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!);
      const camel = keys.filter((k) => /[a-z][A-Z]/.test(k));
      assert.deepEqual(camel, [], `${url} leaks camelCase keys: ${camel.join(', ')}`);
    }
  });

  test('the FAQ answers the questions people actually asked', async () => {
    const r = await app.inject({ method: 'GET', url: '/faq' });
    assert.equal(r.statusCode, 200);
    // Other pages deep-link to these, and faq.js opens the target on load.
    for (const id of ['allowance', 'mcp', 'figma', 'learns']) {
      assert.match(r.body, new RegExp(`id="${id}"`), `/faq#${id} has no target`);
    }
    assert.match(r.body, /100 gated effects/, 'the allowance answer should name the cap');
    assert.match(r.body, /1,000 gated effects/, 'and the free plan');
  });

  test('every page deep-linking into the FAQ points at an anchor that exists', async () => {
    const faq = await app.inject({ method: 'GET', url: '/faq' });
    for (const page of ['/', '/pricing', '/start', '/works-with', '/vendors']) {
      const r = await app.inject({ method: 'GET', url: page });
      for (const m of r.body.matchAll(/href="\/faq#([a-z-]+)"/g)) {
        assert.match(faq.body, new RegExp(`id="${m[1]}"`),
          `${page} links to /faq#${m[1]}, which does not exist`);
      }
    }
  });
});

describe('the feedback letterbox', () => {
  test('takes a vote with no credential at all', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/feedback',
      payload: { path: '/pricing', was_clear: true, viewport: 'phone' },
    });
    assert.equal(r.statusCode, 202);
    assert.deepEqual(r.json(), { received: true });
  });

  test('a typo is rejected rather than silently dropped', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/feedback',
      payload: { path: '/pricing', wasClear: true },   // camelCase: not the wire
    });
    assert.equal(r.statusCode, 400);
  });

  test('an unknown field is refused, not ignored', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/feedback',
      payload: { path: '/pricing', was_clear: true, admin: true },
    });
    assert.equal(r.statusCode, 400);
  });

  // The filter must not be discoverable. A caller who learns which paths are
  // dropped learns how to pick one that is not.
  test('a rejected submission is answered exactly like an accepted one', async () => {
    const good = await app.inject({
      method: 'POST', url: '/v1/feedback',
      payload: { path: '/pricing', was_clear: false },
    });
    const bad = await app.inject({
      method: 'POST', url: '/v1/feedback',
      payload: { path: '/../etc/passwd', was_clear: false },
    });
    assert.equal(good.statusCode, bad.statusCode);
    assert.deepEqual(good.json(), bad.json());
  });

  // Site feedback belongs to no workspace, so no workspace credential should
  // ever read it. There is no HTTP read at all, and that is the point.
  test('there is no way to read it back over HTTP', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const r = await app.inject({ method, url: '/v1/feedback' });
      assert.ok(r.statusCode === 404 || r.statusCode === 405,
        `${method} /v1/feedback should not exist, got ${r.statusCode}`);
    }
  });

  test('it is documented in the OpenAPI the agents read', async () => {
    const r = await app.inject({ method: 'GET', url: '/openapi.json' });
    const doc = r.json() as { paths: Record<string, Record<string, unknown>> };
    assert.ok(doc.paths['/v1/feedback']?.post, 'the write should be published');
    assert.ok(!doc.paths['/v1/feedback']?.get, 'there is no read to publish');
  });
});

/**
 * Staging runs with NODE_ENV=production so it exercises the same assertions and
 * the same code paths as the real thing. The cost of that fidelity is that
 * isProd cannot tell them apart, and a byte-identical copy of the marketing
 * site under a second hostname is a duplicate-content problem and a way for
 * someone to find a half-tested build in a search result.
 */
describe('staging is not indexable', () => {
  test('production carries no noindex header and allows crawling', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    assert.equal(r.headers['x-robots-tag'], undefined,
      'the real site must never be told not to index itself');

    const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
    assert.equal(robots.statusCode, 200);
    assert.doesNotMatch(robots.body, /^Disallow: \/$/m);
  });

  test('with RATCHET_ENV=staging, every response says noindex', async () => {
    process.env.RATCHET_ENV = 'staging';
    const staging = await buildApp({ logger: false });
    await staging.ready();
    try {
      // Not only HTML: a JSON endpoint and a redirect carry it too, which is
      // the reason for a header rather than a meta tag.
      for (const url of ['/', '/v1/vendors', '/blog']) {
        const r = await staging.inject({ method: 'GET', url });
        assert.match(String(r.headers['x-robots-tag']), /noindex/,
          `${url} did not carry the noindex header`);
      }

      const robots = await staging.inject({ method: 'GET', url: '/robots.txt' });
      assert.match(robots.body, /^Disallow: \/$/m, 'staging robots.txt must disallow everything');
      assert.match(robots.body, /ratchetgate\.com/, 'and point at the real service');
    } finally {
      await staging.close();
      delete process.env.RATCHET_ENV;
    }
  });
});

describe('the plain-words page', () => {
  /**
   * The audience for this page is the one least able to route around a broken
   * link: somebody who is not technical, arrived unsure, and will not try twice.
   */
  test('it is served, and reachable from every page', async () => {
    const r = await app.inject({ method: 'GET', url: '/simple' });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /What is this, actually\?/);

    const partials = readFileSync(
      new URL('../../web/assets/partials.js', import.meta.url), 'utf8');
    assert.match(partials, /href="\/simple"/,
      'the footer must link it — this page cannot be found by searching for a term '
      + 'its reader does not know');
  });

  test('it explains itself without the vocabulary the rest of the site uses', () => {
    const html = readFileSync(new URL('../../web/simple.html', import.meta.url), 'utf8');
    const body = html.replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const term of ['idempoten', 'at-most-once', 'fencing token', 'lease']) {
      assert.equal(new RegExp(term, 'i').test(body), false,
        `"${term}" appears on the page that promised no jargon`);
    }
  });
});
