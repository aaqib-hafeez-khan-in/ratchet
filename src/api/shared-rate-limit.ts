// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * A rate-limit store that is shared across instances without putting the
 * database on the request path.
 *
 * THE PROBLEM. @fastify/rate-limit counts in process memory, so N instances
 * allow roughly N times the configured rate. That is not an abstract concern
 * here: the manifest publishes exact per-plan limits, and Fly is configured to
 * auto-start a second app machine under load. The moment it does, a free
 * workspace advertised 120 requests a minute gets 240.
 *
 * THE OBVIOUS FIX IS WORSE THAN IT LOOKS. Putting the counter in Postgres and
 * reading it per request adds a round trip to every call — including the gate,
 * which costs about 2.5 ms of work — in order to police a ceiling that almost
 * no caller ever approaches. It also makes the database a hard dependency of
 * *rejecting* traffic, so a slow database becomes a slow site rather than
 * merely a degraded one.
 *
 * WHAT THIS DOES INSTEAD. Each instance counts locally and, in the background,
 * pushes its delta to a shared row and reads back the global total. Between
 * flushes it answers from `globalAtLastFlush + unflushedLocal`. So:
 *
 *   - `incr` is synchronous and never awaits the database. Zero added latency.
 *   - Writes are proportional to instances × flush rate, not to traffic:
 *     two instances at a 250 ms interval is 8 writes a second at any load.
 *   - The error is bounded by what all instances can do inside one flush
 *     interval. At 120/min and 250 ms that is a fraction of one request; the
 *     overshoot is far smaller than the 2x it replaces.
 *
 * FAILURE BEHAVIOUR. If the database is unreachable the store keeps serving
 * from local counts — which is exactly the per-process behaviour that shipped
 * before, so a database problem degrades the limiter to where it already was
 * rather than failing requests. It never fails a request it would otherwise
 * have allowed.
 *
 * Windows are fixed and aligned to the wall clock so every instance agrees on
 * which window it is in without coordinating.
 */
import { getPool } from '../db/pool.js';

interface Bucket {
  /** The caller's bucket, e.g. `key:ab12cd34ef56` or `ip:203.0.113.9`. */
  key: string;
  /** Window length in ms. Part of the identity: a one-minute and a one-hour
   *  limit for the same caller are different counters, and their windows can
   *  align exactly on the hour — sharing a row there would merge them. */
  timeWindow: number;
  windowStart: number;
  /** Everything this instance has counted in this window. */
  observed: number;
  /** How much of `observed` has been pushed to the shared row. */
  flushed: number;
  /** Shared total as of the last successful flush, including our `flushed`. */
  globalAtLastFlush: number;
  lastTouched: number;
}

/** Bounded so a flood of distinct keys cannot grow this without limit. */
const MAX_BUCKETS = 20_000;

/**
 * State belonging to ONE instance of the service, shared by every route.
 *
 * This is a separate object for a reason that cost real tail latency to find.
 * The store originally shared its bucket map with each route child by copying
 * fields, including the flush timer — but a child created before the parent's
 * timer existed copied `null` and started a second loop of its own. Several
 * loops then raced over one bucket map and, worse, over the same database row,
 * producing lock waits that showed up as isolated 1.2-second requests in an
 * otherwise 2 ms benchmark. One registry, one timer, one flush at a time.
 */
class Registry {
  buckets = new Map<string, Bucket>();
  timer: NodeJS.Timeout | null = null;
  flushing = false;
  degraded = false;
  constructor(readonly flushIntervalMs: number) {}
}

export class SharedRateLimitStore {
  private reg: Registry;

  constructor(
    private timeWindow: number = 60_000,
    flushIntervalMs: number = 250,
    registry?: Registry,
  ) {
    this.reg = registry ?? new Registry(flushIntervalMs);
  }

  /** Fastify calls this per route; the window differs, the state does not. */
  child(routeOptions: { timeWindow?: number }): SharedRateLimitStore {
    return new SharedRateLimitStore(
      typeof routeOptions?.timeWindow === 'number' ? routeOptions.timeWindow : this.timeWindow,
      this.reg.flushIntervalMs,
      this.reg);
  }

  private windowStartFor(now: number, timeWindow: number): number {
    return Math.floor(now / timeWindow) * timeWindow;
  }

  /**
   * Buckets are keyed by window as well as by caller: two routes with different
   * windows must not share a counter just because they share a caller.
   */
  private bucketKey(key: string, timeWindow: number, windowStart: number): string {
    return `${key}|${timeWindow}|${windowStart}`;
  }

  private bucketFor(key: string, timeWindow: number, now: number): Bucket {
    const windowStart = this.windowStartFor(now, timeWindow);
    const id = this.bucketKey(key, timeWindow, windowStart);
    let b = this.reg.buckets.get(id);
    if (!b) {
      b = { key, timeWindow, windowStart, observed: 0, flushed: 0,
            globalAtLastFlush: 0, lastTouched: now };
      this.reg.buckets.set(id, b);
    }
    b.lastTouched = now;
    return b;
  }

  private estimate(b: Bucket): number {
    return b.globalAtLastFlush + (b.observed - b.flushed);
  }

  private ttlOf(b: Bucket, timeWindow: number, now: number): number {
    return Math.max(0, b.windowStart + timeWindow - now);
  }

  incr(
    key: string,
    cb: (err: Error | null, res: { current: number; ttl: number }) => void,
    timeWindow: number,
    _max?: number,
  ): void {
    const now = Date.now();
    const window = timeWindow || this.timeWindow;
    const b = this.bucketFor(key, window, now);
    b.observed += 1;
    this.ensureFlushing();
    cb(null, { current: this.estimate(b), ttl: this.ttlOf(b, window, now) });
  }

  /** Non-mutating peek, same contract as incr. */
  read(
    key: string,
    cb: (err: Error | null, res: { current: number; ttl: number }) => void,
    timeWindow: number,
    _max?: number,
  ): void {
    const now = Date.now();
    const window = timeWindow || this.timeWindow;
    const windowStart = this.windowStartFor(now, window);
    const b = this.reg.buckets.get(this.bucketKey(key, window, windowStart));
    if (!b) { cb(null, { current: 0, ttl: 0 }); return; }
    cb(null, { current: this.estimate(b), ttl: this.ttlOf(b, window, now) });
  }

  private ensureFlushing(): void {
    if (this.reg.timer) return;
    this.reg.timer = setInterval(() => { void this.flush(); }, this.reg.flushIntervalMs);
    // Never hold the process open for a counter.
    this.reg.timer.unref?.();
  }

  /** Exposed for tests; the interval calls it. */
  async flush(): Promise<void> {
    if (this.reg.flushing) return;
    this.reg.flushing = true;
    try {
      const now = Date.now();
      const dirty = [...this.reg.buckets.entries()].filter(([, b]) => b.observed > b.flushed);
      for (const [, b] of dirty) {
        const delta = b.observed - b.flushed;
        // Window length belongs in the row key: two limits for one caller whose
        // windows happen to start at the same instant must not share a counter.
        const rowKey = `${b.key}|${b.timeWindow}`;
        try {
          const { rows } = await getPool().query<{ count: string }>(
            `INSERT INTO rate_limit_counters (bucket_key, window_start, count)
             VALUES ($1, to_timestamp($2 / 1000.0), $3)
             ON CONFLICT (bucket_key, window_start)
             DO UPDATE SET count = rate_limit_counters.count + EXCLUDED.count
             RETURNING count`,
            [rowKey, b.windowStart, delta]);
          b.flushed += delta;
          b.globalAtLastFlush = Number(rows[0]?.count ?? b.flushed);
          this.reg.degraded = false;
        } catch {
          // Deliberately silent per key: the store keeps working from local
          // counts, which is the behaviour that shipped before it existed.
          this.reg.degraded = true;
          break;
        }
      }
      this.evict(now);
    } finally {
      this.reg.flushing = false;
    }
  }

  /** Drop windows that have ended, and cap total size. */
  private evict(now: number): void {
    for (const [id, b] of this.reg.buckets) {
      // Judge each bucket by its OWN window, not this view's — an hour-long
      // counter must not be evicted on a one-minute route's schedule.
      if (b.windowStart + b.timeWindow * 2 < now) this.reg.buckets.delete(id);
    }
    if (this.reg.buckets.size <= MAX_BUCKETS) return;
    const byAge = [...this.reg.buckets.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched);
    for (const [id] of byAge.slice(0, this.reg.buckets.size - MAX_BUCKETS)) this.reg.buckets.delete(id);
  }

  /** True when the last flush failed and counts are local-only. */
  get isDegraded(): boolean { return this.reg.degraded; }

  stop(): void {
    if (this.reg.timer) { clearInterval(this.reg.timer); this.reg.timer = null; }
  }
}

/**
 * @fastify/rate-limit takes a store *constructor* and calls `new Store(params)`
 * itself, then `child(routeOptions)` for every route that overrides the limit.
 * This adapts one live instance into a constructor bound to it, so every route
 * and every child share a single bucket map and a single flush loop instead of
 * each opening its own.
 */
export function storeClassFor(instance: SharedRateLimitStore): new (params: {
  timeWindow?: number;
}) => { incr: SharedRateLimitStore['incr']; read: SharedRateLimitStore['read']; child: unknown } {
  return class BoundStore {
    private inner: SharedRateLimitStore;
    constructor(params: { timeWindow?: number } = {}) {
      this.inner = typeof params?.timeWindow === 'number'
        ? instance.child({ timeWindow: params.timeWindow })
        : instance;
    }
    incr(...args: Parameters<SharedRateLimitStore['incr']>) { return this.inner.incr(...args); }
    read(...args: Parameters<SharedRateLimitStore['read']>) { return this.inner.read(...args); }
    child(routeOptions: { timeWindow?: number }) {
      const Bound = storeClassFor(this.inner);
      return new Bound(routeOptions ?? {});
    }
  };
}
