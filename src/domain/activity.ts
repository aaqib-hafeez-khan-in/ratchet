import { getPool, type Db } from '../db/pool.js';

/**
 * Product analytics, kept in-house.
 *
 * Sending usage data to a third-party analytics vendor would contradict the
 * one thing this service promises about data: that it stores a fingerprint and
 * not your content. Everything the operating thresholds need is already
 * derivable from Postgres, so it stays here.
 *
 * Two shapes only:
 *  - `workspace_activity`: one row per workspace per UTC day. Bounded by
 *    (workspaces x days), never by effect volume.
 *  - `workspace_milestones`: one row per workspace per first-time event.
 *
 * Neither is garbage collected, because effect records are — a 7-day retention
 * window would otherwise erase the cohort evidence a week after it was created.
 *
 * All writes are fire-and-forget. Analytics must never fail a customer request
 * and must never sit inside the begin() transaction, which is deliberately
 * short.
 */

export type Milestone =
  | 'workspace_created'
  | 'first_begin'
  | 'first_success'        // activation: a complete execute → report cycle
  | 'first_indeterminate'
  | 'first_resolve'
  | 'first_paid';

type Counter = 'effects_begun' | 'effects_succeeded' | 'effects_indeterminate';

/**
 * Counters are buffered in memory and flushed on a timer.
 *
 * The first implementation wrote straight through, fire-and-forget. Measured,
 * that cost more than it looked: two extra queries per request competed with
 * the request itself for a fixed connection pool, and duplicate-replay latency
 * went from 0.22 ms to 1.61 ms. Buffering turns thousands of writes into one
 * per interval and puts the hot path back where it was.
 *
 * The trade is losing at most one interval of counters if the process dies.
 * That is the right trade for aggregate analytics and would not be for a
 * ledger — which is why the money path does none of this.
 */
const pending = new Map<string, Record<Counter, number>>();
const seenMilestones = new Set<string>();

let flushTimer: NodeJS.Timeout | null = null;

function bucket(workspaceId: string): Record<Counter, number> {
  let b = pending.get(workspaceId);
  if (!b) {
    b = { effects_begun: 0, effects_succeeded: 0, effects_indeterminate: 0 };
    pending.set(workspaceId, b);
  }
  return b;
}

/** Records a day of activity. Cheap enough to call on every request. */
export function recordActivity(workspaceId: string, counter: Counter, n = 1): void {
  bucket(workspaceId)[counter] += n;
}

/** Writes buffered counters. Called on a timer, at shutdown, and by tests. */
export async function flushActivity(): Promise<number> {
  if (pending.size === 0) return 0;
  const batch = [...pending.entries()];
  pending.clear();

  let written = 0;
  for (const [workspaceId, c] of batch) {
    try {
      await getPool().query(
        `INSERT INTO workspace_activity
           (workspace_id, day, effects_begun, effects_succeeded, effects_indeterminate)
         VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2, $3, $4)
         ON CONFLICT (workspace_id, day) DO UPDATE SET
           effects_begun         = workspace_activity.effects_begun + EXCLUDED.effects_begun,
           effects_succeeded     = workspace_activity.effects_succeeded + EXCLUDED.effects_succeeded,
           effects_indeterminate = workspace_activity.effects_indeterminate + EXCLUDED.effects_indeterminate`,
        [workspaceId, c.effects_begun, c.effects_succeeded, c.effects_indeterminate],
      );
      written++;
    } catch {
      // A workspace deleted mid-flush, or the database briefly away. Analytics
      // must never escalate; the counts are simply lost.
    }
  }
  return written;
}

export function startActivityFlusher(intervalMs = 5_000): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { void flushActivity(); }, intervalMs);
  flushTimer.unref();
}

export async function stopActivityFlusher(): Promise<void> {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  await flushActivity();
}

/**
 * Records a milestone the first time only.
 *
 * Also remembered in memory, because the caller fires this on every successful
 * report and only the first one can ever do anything — without the in-process
 * check, every later report would pay for a write that inserts nothing.
 */
export function recordMilestone(
  workspaceId: string, milestone: Milestone, detail: Record<string, unknown> = {},
): void {
  const key = `${workspaceId}|${milestone}`;
  if (seenMilestones.has(key)) return;
  seenMilestones.add(key);
  void getPool().query(
    `INSERT INTO workspace_milestones (workspace_id, milestone, detail)
     VALUES ($1,$2,$3) ON CONFLICT (workspace_id, milestone) DO NOTHING`,
    [workspaceId, milestone, JSON.stringify(detail)],
  ).catch(() => { seenMilestones.delete(key); });
}

/**
 * Transactional variant. The worker is batch work, not a latency-sensitive
 * path, so it records atomically with the state transition rather than
 * fire-and-forget — a fire-and-forget write can be lost when the process exits.
 */
export async function recordActivityTx(
  db: Db, workspaceId: string, counter: Counter, n = 1,
): Promise<void> {
  await db.query(
    `INSERT INTO workspace_activity (workspace_id, day, ${counter})
     VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)
     ON CONFLICT (workspace_id, day)
     DO UPDATE SET ${counter} = workspace_activity.${counter} + EXCLUDED.${counter}`,
    [workspaceId, n],
  );
}

/** Synchronous variant for use inside a transaction that is already open. */
export async function recordMilestoneTx(
  db: Db, workspaceId: string, milestone: Milestone, detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO workspace_milestones (workspace_id, milestone, detail)
     VALUES ($1,$2,$3) ON CONFLICT (workspace_id, milestone) DO NOTHING`,
    [workspaceId, milestone, JSON.stringify(detail)],
  );
}
