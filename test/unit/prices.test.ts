// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-to-pass-checks';
process.env.DATABASE_URL = 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet_test';

const { usdPrice, clearPriceCache, PriceUnavailable } = await import('../../src/domain/prices.js');

/** Serves a fixed price per source, or throws for sources set to null. */
function stubSources(prices: Record<string, number | null>) {
  mock.method(globalThis, 'fetch', async (url: any) => {
    const u = String(url);
    const src = u.includes('coinbase') ? 'coinbase' : u.includes('kraken') ? 'kraken' : 'other';
    const px = prices[src];
    if (px === null || px === undefined) return new Response('nope', { status: 503 });
    const body = src === 'coinbase'
      ? { data: { amount: String(px) } }
      : { result: { XXBTZUSD: { c: [String(px)] } } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe('price oracle', () => {
  beforeEach(() => { mock.restoreAll(); clearPriceCache(); });

  test('agreeing sources produce a median price', async () => {
    stubSources({ coinbase: 60_000, kraken: 60_200 });
    const r = await usdPrice('BTC');
    assert.equal(r.usd, 60_100, 'median of two is their midpoint');
    assert.deepEqual(r.sources.sort(), ['coinbase', 'kraken']);
  });

  test('one source alone is refused — a single feed is a rumour, not a price', async () => {
    stubSources({ coinbase: 60_000, kraken: null });
    await assert.rejects(() => usdPrice('BTC'), (e: Error) => {
      assert.ok(e instanceof PriceUnavailable);
      assert.match(e.message, /Only 1 usable price source/);
      return true;
    });
  });

  test('sources that disagree materially are refused rather than averaged', async () => {
    // 60,000 vs 75,000 is 2,500bps — one of them is wrong and there is no way
    // to tell which. Averaging would launder a bad number into a real quote.
    stubSources({ coinbase: 60_000, kraken: 75_000 });
    await assert.rejects(() => usdPrice('BTC'), (e: Error) => {
      assert.match(e.message, /disagree by \d+bps/);
      return true;
    });
  });

  test('small disagreement within tolerance is accepted', async () => {
    stubSources({ coinbase: 60_000, kraken: 60_500 });   // ~83bps, under 200
    const r = await usdPrice('BTC');
    assert.equal(r.usd, 60_250);
  });

  test('implausible values are dropped before they can drag the median', async () => {
    stubSources({ coinbase: 60_000, kraken: 0.5 });      // outside BTC bounds
    await assert.rejects(() => usdPrice('BTC'), (e: Error) => {
      assert.match(e.message, /Only 1 usable price source/);
      return true;
    });
  });

  test('zero and negative prices are never used', async () => {
    stubSources({ coinbase: 0, kraken: -5 });
    await assert.rejects(() => usdPrice('BTC'), (e: Error) => e instanceof PriceUnavailable);
  });

  test('a price is cached, so quoting in a burst does not hammer the sources', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async (url: any) => {
      calls++;
      const src = String(url).includes('coinbase') ? 'coinbase' : 'kraken';
      const body = src === 'coinbase'
        ? { data: { amount: '60000' } } : { result: { X: { c: ['60000'] } } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await usdPrice('BTC');
    const afterFirst = calls;
    await usdPrice('BTC');
    await usdPrice('BTC');
    assert.equal(calls, afterFirst, 'later calls inside the TTL are served from cache');
  });

  test('every source failing is refused, not defaulted', async () => {
    stubSources({ coinbase: null, kraken: null });
    await assert.rejects(() => usdPrice('BTC'), (e: Error) => e instanceof PriceUnavailable);
  });
});
