// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Two instances must enforce ONE limit, not one each.
 *
 * @fastify/rate-limit counts in process memory. The manifest publishes exact
 * per-plan numbers and fly.toml auto-starts a second app machine under load, so
 * before this store existed a free workspace advertised 120 requests a minute
 * received 240 the moment Fly scaled out. These tests build two stores over one
 * database — the same shape as two machines — and assert the total.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, getPool, closePool } from '../helpers.js';
import { SharedRateLimitStore } from '../../src/api/shared-rate-limit.js';

const WINDOW = 60_000;

/**
 * Long enough that the store's own timer never fires during a test. Every test
 * here drives `flush()` by hand; letting a background flush interleave made the
 * counts nondeterministic and the suite flaky.
 */
const MANUAL = 3_600_000;

/** The row key the store writes: the caller's bucket plus the window length. */
const rowKey = (key: string, window = WINDOW) => `${key}|${window}`;

/** Promise wrapper: the plugin's store contract is callback-shaped. */
const incr = (s: SharedRateLimitStore, key: string, window = WINDOW) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) =>
    s.incr(key, (e, r) => (e ? reject(e) : resolve(r)), window));
const read = (s: SharedRateLimitStore, key: string) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) =>
    s.read(key, (e, r) => (e ? reject(e) : resolve(r)), WINDOW));

describe('rate-limit counters are shared across instances', () => {
  before(async () => { await setupDb(); });
  after(async () => { await closePool(); });
  beforeEach(async () => { await getPool().query('DELETE FROM rate_limit_counters'); });

  test('two instances converge on one total', async () => {
    const a = new SharedRateLimitStore(WINDOW, MANUAL);
    const b = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:conv-${Date.now()}`;
      for (let i = 0; i < 50; i++) await incr(a, key);
      for (let i = 0; i < 30; i++) await incr(b, key);
      await a.flush();
      await b.flush();

      // The shared row is exact immediately: no double counting, nothing lost.
      const { rows } = await getPool().query(
        'SELECT count::int FROM rate_limit_counters WHERE bucket_key = $1', [rowKey(key)]);
      assert.equal(rows[0].count, 80, 'the shared row must hold exactly what was counted');

      // An instance learns the global total on ITS next flush, not the moment
      // another instance writes. A flushed before B, so A cannot yet know about
      // B's 30 — that staleness is the design's bounded error, and it lasts one
      // flush interval for any instance that is actually serving traffic.
      assert.ok((await read(a, key)).current < 80,
        'A should still be reporting its own view until it flushes again');

      await incr(a, key); await a.flush();
      await incr(b, key); await b.flush();
      const seenByA = (await read(a, key)).current;
      const seenByB = (await read(b, key)).current;

      // The exact figure depends on which instance flushed last — each is one
      // flush behind the other's newest write, forever, by construction. What
      // must be true is that neither is reporting only its own traffic: A
      // counted 51 locally and B counted 31, so seeing 80+ proves each is
      // enforcing against the shared total.
      assert.ok(seenByA >= 80, `instance A saw ${seenByA}, expected the shared total (80+)`);
      assert.ok(seenByB >= 80, `instance B saw ${seenByB}, expected the shared total (80+)`);
      assert.ok(seenByA > 51, 'A must be counting more than its own 51 requests');
      assert.ok(seenByB > 31, 'B must be counting more than its own 31 requests');
    } finally { a.stop(); b.stop(); }
  });

  test('the counter never double-counts across repeated flushes', async () => {
    const s = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:once-${Date.now()}`;
      for (let i = 0; i < 20; i++) await incr(s, key);
      await s.flush();
      await s.flush();          // nothing new to push
      await s.flush();
      const { rows } = await getPool().query(
        'SELECT count::int FROM rate_limit_counters WHERE bucket_key = $1', [rowKey(key)]);
      assert.equal(rows[0].count, 20, 'a flush with no delta must not add anything');
    } finally { s.stop(); }
  });

  test('a limit of 120 is not 240 with two instances', async () => {
    // The exact regression: the free plan's published allowance, split across
    // two machines, must still total 120.
    const a = new SharedRateLimitStore(WINDOW, MANUAL);
    const b = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:plan-${Date.now()}`;
      const LIMIT = 120;
      let admitted = 0;
      // Alternate between machines, flushing often, as a load balancer would.
      for (let i = 0; i < 300; i++) {
        const inst = i % 2 === 0 ? a : b;
        const { current } = await incr(inst, key);
        if (current <= LIMIT) admitted++;
        if (i % 10 === 9) { await a.flush(); await b.flush(); }
      }
      // Overshoot is bounded by what both instances can do between flushes.
      assert.ok(admitted >= LIMIT - 20 && admitted <= LIMIT + 20,
        `admitted ${admitted}; expected close to ${LIMIT}, and nowhere near ${LIMIT * 2}`);
      assert.ok(admitted < LIMIT * 1.5,
        `admitted ${admitted}, which is approaching the per-process doubling this replaces`);
    } finally { a.stop(); b.stop(); }
  });

  test('windows are aligned, so instances agree without coordinating', async () => {
    const a = new SharedRateLimitStore(WINDOW, MANUAL);
    const b = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:win-${Date.now()}`;
      await incr(a, key); await a.flush();
      await incr(b, key); await b.flush();
      const { rows } = await getPool().query(
        'SELECT count(*)::int AS n FROM rate_limit_counters WHERE bucket_key = $1', [rowKey(key)]);
      assert.equal(rows[0].n, 1, 'both instances must land in the same window row');
    } finally { a.stop(); b.stop(); }
  });

  test('a database failure degrades to local counting, never to rejection', async () => {
    const s = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:degrade-${Date.now()}`;
      await getPool().query('ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_hidden');
      try {
        for (let i = 0; i < 10; i++) {
          const r = await incr(s, key);       // must not throw
          assert.ok(r.current > 0);
        }
        await s.flush();
        assert.equal(s.isDegraded, true, 'the store should know it is degraded');
        const r = await incr(s, key);
        assert.equal(r.current, 11, 'local counting continues while the database is unavailable');
      } finally {
        await getPool().query('ALTER TABLE rate_limit_counters_hidden RENAME TO rate_limit_counters');
      }
      // And it recovers on its own once the database is back.
      await s.flush();
      assert.equal(s.isDegraded, false, 'the store should recover without a restart');
    } finally { s.stop(); }
  });

  test('two windows for one caller never share a counter', async () => {
    // /v1/effects/begin limits per minute; /v1/workspaces limits per hour. Both
    // key on the same caller, and on the hour their windows start at the same
    // instant — sharing a row there would let one route's traffic exhaust the
    // other's allowance.
    const s = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:multi-${Date.now()}`;
      const minute = s.child({ timeWindow: 60_000 });
      const hour = s.child({ timeWindow: 3_600_000 });
      for (let i = 0; i < 7; i++) await incr(minute, key, 60_000);
      for (let i = 0; i < 3; i++) await incr(hour, key, 3_600_000);
      await s.flush();

      const { rows } = await getPool().query(
        `SELECT bucket_key, count::int FROM rate_limit_counters
          WHERE bucket_key LIKE $1 ORDER BY bucket_key`, [`${key}|%`]);
      assert.equal(rows.length, 2, 'each window length needs its own row');
      const counts = Object.fromEntries(rows.map((r: any) => [r.bucket_key, r.count]));
      assert.equal(counts[`${key}|60000`], 7);
      assert.equal(counts[`${key}|3600000`], 3);
    } finally { s.stop(); }
  });

  test('a child shares one flush loop with its parent', async () => {
    // Children used to copy the timer field, so one created before the parent
    // had started its loop would spin up a second. Several loops then raced
    // over one bucket map and one database row, which showed up as isolated
    // multi-second requests in an otherwise 2 ms benchmark.
    const s = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:oneloop-${Date.now()}`;
      const c1 = s.child({ timeWindow: WINDOW });
      const c2 = s.child({ timeWindow: WINDOW });
      for (let i = 0; i < 5; i++) { await incr(c1, key); await incr(c2, key); }
      await s.flush();
      const { rows } = await getPool().query(
        'SELECT count::int FROM rate_limit_counters WHERE bucket_key = $1', [rowKey(key)]);
      assert.equal(rows[0].count, 10,
        'parent and children must share one counter, and flush it once');
    } finally { s.stop(); }
  });

  test('read reports without incrementing', async () => {
    const s = new SharedRateLimitStore(WINDOW, MANUAL);
    try {
      const key = `key:peek-${Date.now()}`;
      await incr(s, key); await incr(s, key);
      const before = await read(s, key);
      const after = await read(s, key);
      assert.equal(before.current, 2);
      assert.equal(after.current, 2, 'read must not advance the counter');
    } finally { s.stop(); }
  });
});
