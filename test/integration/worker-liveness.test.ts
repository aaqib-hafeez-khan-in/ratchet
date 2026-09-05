// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Worker liveness.
 *
 * If the worker stops, leases never expire, effects stay `pending` for ever,
 * and every retry is answered `in_flight` — indefinitely, with no error
 * anywhere. CLAUDE.md calls treating the worker as anything other than
 * long-running the most damaging mistake available in this codebase; these
 * tests are about noticing when it has happened.
 *
 * The case that matters is not a crash — the platform restarts those. It is a
 * wedge: the process alive, the logs quiet, one loop stuck inside a query that
 * never returns.
 *
 * Each test uses its own loop names. The write throttle is process-wide and
 * keyed by loop name, so a shared name would make one test silently skip its
 * write and fail for a reason unrelated to what it checks.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, getPool, closePool } from '../helpers.js';
import {
  recordOk, recordFailure, workerHealth, staleAfterMs, STALE_FLOOR_MS,
} from '../../src/worker/heartbeat.js';

let seq = 0;
const uniq = (base: string) => `${base}-${++seq}`;
const ageOut = (loop: string, interval = '1 hour') => getPool().query(
  `UPDATE worker_heartbeats SET last_ok_at = now() - interval '${interval}'
    WHERE loop_name = $1`, [loop]);

describe('worker liveness', () => {
  before(async () => { await setupDb(); });
  after(async () => { await closePool(); });
  beforeEach(async () => { await getPool().query('DELETE FROM worker_heartbeats'); });

  test('no heartbeat at all is not reported as healthy', async () => {
    // "Never deployed" and "stopped" need different fixes, and an empty table
    // must never read as success.
    const h = await workerHealth();
    assert.equal(h.everStarted, false);
    assert.equal(h.healthy, false);
  });

  test('a fresh loop is healthy', async () => {
    const loop = uniq('sweep');
    await recordOk(loop, 'i-1', 2000);
    const h = await workerHealth();
    assert.equal(h.everStarted, true);
    assert.equal(h.healthy, true);
    assert.equal(h.loops[0]!.stale, false);
    assert.equal(h.loops[0]!.loop, loop);
  });

  test('a loop that stops completing goes stale', async () => {
    const loop = uniq('sweep');
    await recordOk(loop, 'i-1', 2000);
    await ageOut(loop);
    const h = await workerHealth();
    assert.equal(h.healthy, false);
    assert.equal(h.loops[0]!.stale, true);
    assert.ok((h.loops[0]!.secondsSinceOk ?? 0) > 3000);
  });

  test('staleness is judged against the loop own interval', () => {
    // A five-second receipt chainer and an hourly GC cannot share a threshold.
    assert.equal(staleAfterMs(5_000), STALE_FLOOR_MS, 'fast loops get the floor');
    assert.equal(staleAfterMs(3_600_000), 36_000_000, 'slow loops get a proportional window');
    assert.ok(staleAfterMs(2_000) >= STALE_FLOOR_MS,
      'the floor stops a fast loop having an absurdly tight window');
  });

  test('one stalled loop makes the whole worker unhealthy', async () => {
    const good = uniq('sweep');
    const bad = uniq('delivery');
    await recordOk(good, 'i-1', 2000);
    await recordOk(bad, 'i-1', 3000);
    await ageOut(bad);
    const h = await workerHealth();
    assert.equal(h.healthy, false, 'a healthy sweep does not excuse a stalled delivery loop');
    assert.deepEqual(h.loops.filter((l) => l.stale).map((l) => l.loop), [bad]);
  });

  test('a failure does not refresh last_ok_at', async () => {
    // Repeated failures must age into staleness, not masquerade as health by
    // touching the row.
    const loop = uniq('alerts');
    await recordOk(loop, 'i-1', 60_000);
    await ageOut(loop, '2 hours');
    await recordFailure(loop, 'i-1', 60_000, 'provider timeout');
    const h = await workerHealth();
    assert.equal(h.loops[0]!.stale, true, 'a failing loop must still go stale');
    assert.equal(h.loops[0]!.lastError, 'provider timeout');
    assert.equal(h.loops[0]!.consecutiveFailures, 1);
  });

  test('consecutive failures accumulate, and a success clears them', async () => {
    const loop = uniq('delivery');
    for (let i = 0; i < 3; i++) await recordFailure(loop, 'i-1', 3000, `attempt ${i}`);
    let h = await workerHealth();
    assert.equal(h.loops[0]!.consecutiveFailures, 3);

    await recordOk(loop, 'i-1', 3000);
    h = await workerHealth();
    assert.equal(h.loops[0]!.consecutiveFailures, 0);
    assert.equal(h.loops[0]!.lastError, null);
  });

  test('several replicas share one row per loop', async () => {
    // Replicas are safe by design and any healthy one keeps the row fresh —
    // "this work is being done by someone" is the meaning that matters.
    const loop = uniq('sweep');
    await recordOk(loop, 'replica-a', 2000);
    await recordFailure(loop, 'replica-b', 2000, 'b had a turn');
    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n, max(instance) AS who FROM worker_heartbeats');
    assert.equal(rows[0].n, 1, 'one row per loop, not per replica');
    assert.equal(rows[0].who, 'replica-b', 'the most recent writer owns the row');
  });

  test('heartbeat writes are throttled so a 2s loop is not 30 writes a minute', async () => {
    const loop = uniq('chain');
    await recordOk(loop, 'i-1', 5000);
    const first = (await getPool().query(
      'SELECT last_ok_at FROM worker_heartbeats WHERE loop_name = $1', [loop])).rows[0].last_ok_at;
    for (let i = 0; i < 20; i++) await recordOk(loop, 'i-1', 5000);
    const after = (await getPool().query(
      'SELECT last_ok_at FROM worker_heartbeats WHERE loop_name = $1', [loop])).rows[0].last_ok_at;
    assert.equal(after.getTime(), first.getTime(),
      'repeated ticks inside the throttle window must not write');
  });

  test('a failed write does not suppress the next heartbeat', async () => {
    // The throttle records a SUCCESSFUL write. Recording the attempt instead
    // would let one transient database error blank out fifteen seconds of
    // heartbeats, making a blip look like the start of a stall.
    const loop = uniq('sweep');
    await getPool().query('ALTER TABLE worker_heartbeats RENAME TO worker_heartbeats_hidden');
    try {
      await assert.rejects(() => recordOk(loop, 'i-1', 2000));
    } finally {
      await getPool().query('ALTER TABLE worker_heartbeats_hidden RENAME TO worker_heartbeats');
    }
    await recordOk(loop, 'i-1', 2000);
    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM worker_heartbeats WHERE loop_name = $1', [loop]);
    assert.equal(rows[0].n, 1, 'the retry immediately after a failure must land');
  });
});
