// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Worker liveness.
 *
 * The worker must keep running: it expires leases on a timer whether or not a
 * request is in flight. If it stops, leases never expire, effects stay
 * `pending` forever, and every retry is answered `in_flight` — indefinitely,
 * and with no error anywhere. It is the most damaging failure available in this
 * codebase and, until now, nothing detected it.
 *
 * A crash is the easy case; the platform restarts it. The case that needs this
 * module is a **wedge**: the process alive, the logs quiet, and one loop stuck
 * inside a query that never returns. Its `busy` flag stays set, so it never runs
 * again and never complains.
 *
 * Two things follow from that:
 *
 *   Heartbeats record the last *successful completion* of each loop, not the
 *   last attempt. A loop that starts and never finishes must go stale, because
 *   going stale is the only signal it will ever give.
 *
 *   Staleness is judged against the loop's own interval. A five-second receipt
 *   chainer and an hourly GC cannot share one threshold.
 */
import { getPool, type Db } from '../db/pool.js';

/** Written at most this often per loop, so a 2s loop is not 30 writes a minute. */
const MIN_WRITE_INTERVAL_MS = 15_000;

/**
 * How far behind its own schedule a loop may fall before it counts as stale.
 * Generous on purpose: a slow sweep is normal, and an alarm that cries wolf is
 * an alarm nobody reads. The floor covers fast loops whose interval alone would
 * make the window absurdly tight.
 */
export const STALE_MULTIPLIER = 10;
export const STALE_FLOOR_MS = 120_000;

export function staleAfterMs(intervalMs: number): number {
  return Math.max(intervalMs * STALE_MULTIPLIER, STALE_FLOOR_MS);
}

const lastWrite = new Map<string, number>();
/** Last finding written per loop, so a change is never rate limited away. */
const lastNote = new Map<string, string | undefined>();

/**
 * `note` records something the loop FOUND, as distinct from the loop failing.
 * A watcher that successfully observes a sick cluster has done its job; calling
 * that a loop failure would age out its heartbeat and report the worker as
 * stalled, which would be a lie about the wrong component — and on a platform
 * that restarts unhealthy workers, a restart that cannot fix a database.
 */
export async function recordOk(
  loopName: string, instance: string, intervalMs: number, db: Db = getPool(),
  note?: string,
): Promise<void> {
  const now = Date.now();
  // Any CHANGE in what is being reported bypasses the throttle, in both
  // directions. Letting only the arrival of a problem through would leave a
  // resolved one on display until the next unthrottled write — an alarm for
  // something already fixed, which is how monitoring gets ignored.
  const changed = lastNote.get(loopName) !== note;
  if (!changed && now - (lastWrite.get(loopName) ?? 0) < MIN_WRITE_INTERVAL_MS) return;
  await db.query(
    `INSERT INTO worker_heartbeats
       (loop_name, instance, interval_ms, last_ok_at, last_error,
        consecutive_failures, updated_at)
     VALUES ($1,$2,$3,now(),$4,0,now())
     ON CONFLICT (loop_name) DO UPDATE SET
       instance = EXCLUDED.instance, interval_ms = EXCLUDED.interval_ms,
       last_ok_at = now(), last_error = EXCLUDED.last_error,
       consecutive_failures = 0, updated_at = now()`,
    [loopName, instance, intervalMs, note ?? null]);
  // Marked only after the write lands. Recording the attempt instead would let
  // a transient database error suppress the next fifteen seconds of heartbeats,
  // making a brief blip look like the beginning of a stall.
  lastWrite.set(loopName, now);
  lastNote.set(loopName, note);
}

/**
 * A failure is written immediately and never throttled — the whole point is to
 * see it. `last_ok_at` is deliberately untouched, so repeated failures age into
 * staleness rather than masquerading as health.
 */
export async function recordFailure(
  loopName: string, instance: string, intervalMs: number, err: string, db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO worker_heartbeats
       (loop_name, instance, interval_ms, last_ok_at, last_error,
        consecutive_failures, updated_at)
     VALUES ($1,$2,$3,NULL,$4,1,now())
     ON CONFLICT (loop_name) DO UPDATE SET
       instance = EXCLUDED.instance, interval_ms = EXCLUDED.interval_ms,
       last_error = EXCLUDED.last_error,
       consecutive_failures = worker_heartbeats.consecutive_failures + 1,
       updated_at = now()`,
    [loopName, instance, intervalMs, err.slice(0, 500)]);
}

export interface LoopHealth {
  loop: string;
  instance: string;
  intervalMs: number;
  lastOkAt: string | null;
  secondsSinceOk: number | null;
  staleAfterSeconds: number;
  stale: boolean;
  lastError: string | null;
  consecutiveFailures: number;
}

export async function workerHealth(db: Db = getPool()): Promise<{
  healthy: boolean; everStarted: boolean; loops: LoopHealth[];
}> {
  const { rows } = await db.query<{
    loop_name: string; instance: string; interval_ms: number;
    last_ok_at: Date | null; last_error: string | null;
    consecutive_failures: number; seconds_since_ok: string | null;
  }>(
    `SELECT loop_name, instance, interval_ms, last_ok_at, last_error,
            consecutive_failures,
            EXTRACT(EPOCH FROM (now() - last_ok_at)) AS seconds_since_ok
       FROM worker_heartbeats
      ORDER BY loop_name`);

  const loops: LoopHealth[] = rows.map((r) => {
    const staleAfter = staleAfterMs(r.interval_ms);
    const since = r.seconds_since_ok === null ? null : Number(r.seconds_since_ok);
    return {
      loop: r.loop_name,
      instance: r.instance,
      intervalMs: r.interval_ms,
      lastOkAt: r.last_ok_at ? r.last_ok_at.toISOString() : null,
      secondsSinceOk: since === null ? null : Math.round(since),
      staleAfterSeconds: Math.round(staleAfter / 1000),
      stale: since === null || since * 1000 > staleAfter,
      lastError: r.last_error,
      consecutiveFailures: r.consecutive_failures,
    };
  });

  return {
    // A worker that has never run at all is a deployment problem, not a stall,
    // and the two need telling apart — "no rows" must not read as "healthy".
    everStarted: loops.length > 0,
    healthy: loops.length > 0 && loops.every((l) => !l.stale),
    loops,
  };
}
