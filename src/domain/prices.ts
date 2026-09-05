// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { config } from '../lib/config.js';

/**
 * Price oracle for volatile assets.
 *
 * Accepting BTC or ETH means converting a USD quote into a token amount, and
 * that conversion decides how much money arrives. A single price feed is a
 * single point of failure attached directly to revenue: if it is stale, wrong,
 * or manipulated, the service sells credit below cost and finds out later.
 *
 * So this deliberately refuses more than it accepts:
 *
 *  - **At least two independent sources.** One source is not a price, it is a
 *    rumour.
 *  - **They must agree.** If sources diverge by more than the configured
 *    tolerance, something is wrong with one of them and quoting either is
 *    guessing. Refuse instead.
 *  - **Freshness is enforced.** A cached price older than its TTL is discarded
 *    rather than used, because a stale price during a move is exactly when it
 *    is most expensive.
 *  - **Sanity bounds.** A source returning zero, a negative, or a wildly
 *    implausible number is dropped before it can drag the median.
 *
 * A refusal here surfaces as "we cannot quote this right now", which costs one
 * payment. Quoting a bad price costs the difference on every payment until
 * someone notices.
 */

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 6_000;

export class PriceUnavailable extends Error {
  constructor(msg: string) { super(msg); this.name = 'PriceUnavailable'; }
}

interface Quote { source: string; usd: number; at: number; }

const cache = new Map<string, { usd: number; at: number; sources: string[] }>();

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

type Fetcher = (symbol: string) => Promise<number>;

const SOURCES: Record<string, Fetcher> = {
  async coinbase(symbol) {
    const res = await withTimeout(
      fetch(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`), FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`coinbase HTTP ${res.status}`);
    const d = (await res.json()) as { data?: { amount?: string } };
    return Number(d.data?.amount);
  },
  async kraken(symbol) {
    // Kraken uses XBT for bitcoin.
    const pair = symbol === 'BTC' ? 'XBTUSD' : `${symbol}USD`;
    const res = await withTimeout(
      fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`), FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`kraken HTTP ${res.status}`);
    const d = (await res.json()) as { result?: Record<string, { c?: string[] }> };
    const first = d.result && Object.values(d.result)[0];
    return Number(first?.c?.[0]);
  },
};

/** Plausibility bounds. A source outside these is broken, not informative. */
const BOUNDS: Record<string, [number, number]> = {
  BTC: [1_000, 10_000_000],
  ETH: [50, 1_000_000],
};

function sane(symbol: string, usd: number): boolean {
  if (!Number.isFinite(usd) || usd <= 0) return false;
  const b = BOUNDS[symbol];
  return b ? usd >= b[0] && usd <= b[1] : true;
}

/**
 * USD price of one whole token, agreed by at least two independent sources.
 * Throws PriceUnavailable rather than returning a number it does not trust.
 */
export async function usdPrice(symbol: string): Promise<{ usd: number; sources: string[] }> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { usd: hit.usd, sources: hit.sources };
  }

  const names = config.crypto.priceSources.filter((n) => n in SOURCES);
  if (names.length < 2) {
    throw new PriceUnavailable(
      `Pricing ${symbol} needs at least two independent sources; ${names.length} configured. ` +
      'A single feed is a single point of failure attached directly to revenue.');
  }

  const settled = await Promise.allSettled(
    names.map(async (n): Promise<Quote> => ({
      source: n, usd: await SOURCES[n]!(symbol), at: Date.now(),
    })));

  const good = settled
    .filter((r): r is PromiseFulfilledResult<Quote> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((q) => sane(symbol, q.usd));

  if (good.length < 2) {
    throw new PriceUnavailable(
      `Only ${good.length} usable price source(s) responded for ${symbol}. Refusing to quote ` +
      'a volatile asset on one opinion.');
  }

  // Divergence guard: if the sources disagree materially, one of them is wrong
  // and there is no way to tell which.
  const lo = Math.min(...good.map((q) => q.usd));
  const hi = Math.max(...good.map((q) => q.usd));
  const divergenceBps = ((hi - lo) / lo) * 10_000;
  if (divergenceBps > config.crypto.maxPriceDivergenceBps) {
    throw new PriceUnavailable(
      `Price sources for ${symbol} disagree by ${divergenceBps.toFixed(0)}bps ` +
      `(${lo.toFixed(2)}–${hi.toFixed(2)}), over the ${config.crypto.maxPriceDivergenceBps}bps ` +
      'tolerance. Refusing to guess which is right.');
  }

  const sorted = good.map((q) => q.usd).sort((a, b) => a - b);
  const mid = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  const sources = good.map((q) => q.source);
  cache.set(symbol, { usd: mid, at: Date.now(), sources });
  return { usd: mid, sources };
}

/** Test seam: clears memoised prices. */
export function clearPriceCache(): void { cache.clear(); }
