// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * What a customer sees after paying.
 *
 * Stripe returns them to `/console?checkout=success`. The parameter was never
 * read, and the API key is held in memory only — so it does not survive the
 * round trip. Someone who had just been charged $25 landed on a page headed
 * "Create a workspace", with no acknowledgement of any kind. Found by paying.
 *
 * The failure mode is specific and expensive: a customer who believes a payment
 * failed retries it. A product whose own checkout invites a duplicate charge is
 * arguing against itself.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDb, closePool } from '../helpers.js';

const { buildApp } = await import('../../src/api/app.js');
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const asset = (p: string) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');

describe('returning from checkout', () => {
  test('the console has somewhere to announce the return', async () => {
    const r = await app.inject({ method: 'GET', url: '/console' });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /id="checkout-return"/,
      'the console needs a slot for the post-payment banner');
  });

  test('the console reads every state Stripe can return', () => {
    const js = asset('assets/console.js');
    for (const param of ['checkout', 'subscribed', 'subscribe']) {
      assert.ok(js.includes(`'${param}'`),
        `console.js ignores ?${param}=, which is how it silently swallowed a payment`);
    }
    assert.match(js, /No payment was taken/,
      'an abandoned checkout must be acknowledged too, and not as an error');
  });

  /**
   * The tempting repair for the lost key is to put it in `success_url`. That is
   * worse than the bug it fixes: a live key would land in browser history, in
   * the Referer of every subsequent request, and in any log that records query
   * strings. This test exists to make that a deliberate decision rather than an
   * easy one.
   */
  test('the checkout redirect never carries a credential', () => {
    const billing = asset('../src/domain/billing.ts');
    const urls = [...billing.matchAll(/(?:success_url|cancel_url):\s*`([^`]*)`/g)].map((m) => m[1]!);
    assert.ok(urls.length >= 2, 'expected the checkout redirect URLs to be found');
    for (const u of urls) {
      assert.equal(/key=|api_key|token|secret|rk_/.test(u), false,
        `a checkout redirect must not carry a credential: ${u}`);
    }
  });

  test('the banner explains why the session was lost, rather than looking broken', () => {
    const js = asset('assets/console.js');
    assert.match(js, /never written to storage or a URL/,
      'the page must say the signed-out state is deliberate, not a failure');
  });
});
