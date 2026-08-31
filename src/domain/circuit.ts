/**
 * Surge containment — the circuit breaker.
 *
 * WHAT THIS IS FOR. Budget ceilings stop an agent spending too much money.
 * Nothing stopped an agent doing too *much*: a retry loop that sends five
 * thousand emails instead of three, or one that starts charging cards it has
 * never charged before. That is the failure people actually fear from
 * autonomous agents, and it is invisible to per-effect limits because every
 * individual action looks reasonable. Only the rate gives it away.
 *
 * The gate is the one place that can see it. Every intended side effect passes
 * through here *before* it happens, so a surge can be caught while it is still
 * three emails in rather than five thousand.
 *
 * WHY IT DOES NOT KILL THE AGENT. A tripped breaker raises the effect type to
 * `require_approval`, so the work waits for a human instead of dying. The agent
 * keeps its context, the operator gets a decision, and nothing irreversible
 * happens in between. An operator who wants a hard stop can choose `deny`, and
 * one who wants to watch before enforcing can choose `monitor`, which records
 * and alerts but changes no decision.
 *
 * HOW IT STAYS HONEST. The threshold is stored policy and the count is database
 * state. Nothing an agent puts in a payload, a summary, or a result can
 * influence whether the breaker trips — that is the rule in CLAUDE.md §5.6, and
 * it matters more here than anywhere, because a breaker an agent could talk its
 * way past is worse than no breaker at all.
 */
import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import type { Policy } from './types.js';

export type CircuitAction = 'monitor' | 'require_approval' | 'deny';

/** The workspace-wide stop. Reserved: no real effect type may be named this. */
export const ALL_EFFECT_TYPES = '*';

export interface CircuitState {
  effectType: string;
  state: 'closed' | 'open';
  action: CircuitAction;
  trippedAt: Date | null;
  resetsAt: Date | null;
  observed: number | null;
  threshold: number | null;
  reason: string | null;
  openedBy: string | null;
  tripCount: number;
}

interface BreakerRow {
  effect_type: string;
  state: 'closed' | 'open';
  action: CircuitAction;
  tripped_at: Date | null;
  resets_at: Date | null;
  observed: number | null;
  threshold: number | null;
  reason: string | null;
  opened_by: string | null;
  baseline_count: number;
  baseline_hour: Date | null;
  trip_count: number;
}

const view = (r: BreakerRow): CircuitState => ({
  effectType: r.effect_type,
  state: r.state,
  action: r.action,
  trippedAt: r.tripped_at,
  resetsAt: r.resets_at,
  observed: r.observed,
  threshold: r.threshold,
  reason: r.reason,
  openedBy: r.opened_by,
  tripCount: r.trip_count,
});

/**
 * How much of the current hour's count predates the last time this breaker was
 * cleared. Measuring the surge from there is what makes a cooldown mean
 * anything: without it the hour's total is still over the ceiling, so the first
 * effect after the cooldown re-trips immediately and the breaker never reopens
 * for real work.
 */
function baselineFor(row: { baseline_count: number; baseline_hour: Date | null } | undefined,
                     now: Date): number {
  if (!row?.baseline_hour) return 0;
  return row.baseline_hour.getTime() === hourStart(now).getTime() ? row.baseline_count : 0;
}

/** Truncate to the hour the way the counter table does. */
function hourStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Count this new effect against the current hour and return the running total.
 *
 * Called once per genuinely new effect, inside the decision transaction, after
 * the workspace row is already held exclusively — so this cannot introduce a
 * new lock cycle. Duplicates, retries and in-flight checks never reach here,
 * which keeps the common path free of it.
 */
export async function surgeBaseline(
  tx: PoolClient, workspaceId: string, effectType: string, now: Date,
): Promise<number> {
  const { rows } = await tx.query<{ baseline_count: number; baseline_hour: Date | null }>(
    `SELECT baseline_count, baseline_hour FROM circuit_breakers
      WHERE workspace_id = $1 AND effect_type = $2`,
    [workspaceId, effectType]);
  return baselineFor(rows[0], now);
}

export async function countEffect(
  tx: PoolClient, workspaceId: string, effectType: string, now: Date,
): Promise<number> {
  const { rows } = await tx.query<{ count: number }>(
    `INSERT INTO effect_rate_windows (workspace_id, effect_type, hour_start, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (workspace_id, effect_type, hour_start)
     DO UPDATE SET count = effect_rate_windows.count + 1
     RETURNING count`,
    [workspaceId, effectType, hourStart(now)]);
  return rows[0]?.count ?? 1;
}

/**
 * The breakers currently open for a workspace, expiring any whose cooldown has
 * passed. Returns the effect-type-specific one and the workspace-wide one.
 */
export async function openBreakers(
  tx: PoolClient, workspaceId: string, effectType: string, now: Date,
): Promise<CircuitState[]> {
  const { rows } = await tx.query<BreakerRow>(
    `SELECT effect_type, state, action, tripped_at, resets_at, observed,
            threshold, reason, opened_by, baseline_count, baseline_hour, trip_count
       FROM circuit_breakers
      WHERE workspace_id = $1 AND state = 'open'
        AND effect_type IN ($2, $3)`,
    [workspaceId, effectType, ALL_EFFECT_TYPES]);

  const live: CircuitState[] = [];
  for (const r of rows) {
    // A cooldown that has elapsed closes the breaker on read, so recovery does
    // not depend on a worker having run. resets_at NULL means it was opened by
    // hand and stays open until a human closes it.
    if (r.resets_at && r.resets_at <= now) {
      await clearTo(tx, workspaceId, r.effect_type, now);
      continue;
    }
    live.push(view(r));
  }
  return live;
}

/**
 * Close a breaker and start its allowance again from the current count.
 *
 * The effect type gets the rest of the hour measured from here, so a cooldown
 * genuinely gives the agent another chance rather than expiring into an
 * immediate re-trip. The raw counters are untouched, so the rate history an
 * operator uses to choose a threshold stays accurate.
 */
async function clearTo(
  db: Db, workspaceId: string, effectType: string, now: Date,
): Promise<void> {
  await db.query(
    `UPDATE circuit_breakers b
        SET state='closed', resets_at=NULL, updated_at=now(),
            baseline_hour = date_trunc('hour', $3::timestamptz),
            baseline_count = coalesce((
              SELECT w.count FROM effect_rate_windows w
               WHERE w.workspace_id = b.workspace_id
                 AND w.effect_type  = b.effect_type
                 AND w.hour_start   = date_trunc('hour', $3::timestamptz)), 0)
      WHERE b.workspace_id=$1 AND b.effect_type=$2`,
    [workspaceId, effectType, now]);
}

/** Record a trip. Idempotent within a window: re-tripping only extends it. */
export async function trip(
  tx: PoolClient, workspaceId: string, effectType: string,
  args: { action: CircuitAction; observed: number; threshold: number;
          cooldownSeconds: number; reason: string; now: Date },
): Promise<CircuitState> {
  const resetsAt = new Date(args.now.getTime() + args.cooldownSeconds * 1000);
  const { rows } = await tx.query<BreakerRow>(
    `INSERT INTO circuit_breakers
       (workspace_id, effect_type, state, action, tripped_at, resets_at,
        observed, threshold, reason, trip_count, updated_at)
     VALUES ($1,$2,'open',$3,$4,$5,$6,$7,$8,1,now())
     ON CONFLICT (workspace_id, effect_type) DO UPDATE SET
       state='open', action=EXCLUDED.action, tripped_at=EXCLUDED.tripped_at,
       resets_at=EXCLUDED.resets_at, observed=EXCLUDED.observed,
       threshold=EXCLUDED.threshold, reason=EXCLUDED.reason,
       opened_by=NULL,
       trip_count=circuit_breakers.trip_count + 1, updated_at=now()
     RETURNING effect_type, state, action, tripped_at, resets_at, observed,
               threshold, reason, opened_by, baseline_count, baseline_hour, trip_count`,
    [workspaceId, effectType, args.action, args.now, resetsAt,
     args.observed, args.threshold, args.reason]);
  return view(rows[0]!);
}

/**
 * The emergency stop: open a breaker by hand.
 *
 * `effectType` may be `*`, which halts every effect type in the workspace. No
 * cooldown — a breaker a human opened stays open until a human closes it,
 * because "it fixed itself while I was asleep" is not what anyone wants from a
 * control they reached for in a panic.
 */
export async function openManually(
  db: Db, workspaceId: string, effectType: string,
  args: { action: CircuitAction; reason: string; actor: string },
): Promise<CircuitState> {
  const { rows } = await db.query<BreakerRow>(
    `INSERT INTO circuit_breakers
       (workspace_id, effect_type, state, action, tripped_at, resets_at,
        reason, opened_by, trip_count, updated_at)
     VALUES ($1,$2,'open',$3,now(),NULL,$4,$5,1,now())
     ON CONFLICT (workspace_id, effect_type) DO UPDATE SET
       state='open', action=EXCLUDED.action, tripped_at=now(), resets_at=NULL,
       reason=EXCLUDED.reason, opened_by=EXCLUDED.opened_by,
       trip_count=circuit_breakers.trip_count + 1, updated_at=now()
     RETURNING effect_type, state, action, tripped_at, resets_at, observed,
               threshold, reason, opened_by, baseline_count, baseline_hour, trip_count`,
    [workspaceId, effectType, args.action, args.reason, args.actor]);
  return view(rows[0]!);
}

/** Close a breaker. Returns null when there was nothing open to close. */
export async function close(
  db: Db, workspaceId: string, effectType: string, now = new Date(),
): Promise<CircuitState | null> {
  await clearTo(db, workspaceId, effectType, now);
  const { rows } = await db.query<BreakerRow>(
    `SELECT effect_type, state, action, tripped_at, resets_at, observed,
            threshold, reason, opened_by, baseline_count, baseline_hour, trip_count
       FROM circuit_breakers WHERE workspace_id=$1 AND effect_type=$2`,
    [workspaceId, effectType]);
  return rows[0] ? view(rows[0]) : null;
}

/** Every breaker a workspace has, open or not, most recently changed first. */
export async function listCircuits(
  db: Db, workspaceId: string,
): Promise<CircuitState[]> {
  const { rows } = await db.query<BreakerRow>(
    `SELECT effect_type, state, action, tripped_at, resets_at, observed,
            threshold, reason, opened_by, baseline_count, baseline_hour, trip_count
       FROM circuit_breakers WHERE workspace_id = $1
      ORDER BY updated_at DESC`,
    [workspaceId]);
  return rows.map(view);
}

/** Current-hour counts per effect type, so an operator can pick a threshold. */
export async function currentRates(
  db: Db, workspaceId: string,
): Promise<Array<{ effectType: string; thisHour: number; peakHour: number }>> {
  const { rows } = await db.query<{ effect_type: string; this_hour: number; peak_hour: number }>(
    `SELECT effect_type,
            coalesce(max(count) FILTER (WHERE hour_start = date_trunc('hour', now())), 0)::int AS this_hour,
            max(count)::int AS peak_hour
       FROM effect_rate_windows
      WHERE workspace_id = $1 AND hour_start > now() - interval '30 days'
      GROUP BY effect_type
      ORDER BY peak_hour DESC`,
    [workspaceId]);
  return rows.map((r) => ({
    effectType: r.effect_type, thisHour: r.this_hour, peakHour: r.peak_hour,
  }));
}

/**
 * What the effective mode should be, given the policy and any open breaker.
 *
 * `monitor` deliberately returns the unchanged mode: it exists so an operator
 * can see what would have been stopped before trusting it to stop anything.
 */
export function applyBreaker(policy: Policy, breakers: CircuitState[]): {
  mode: Policy['mode']; breaker: CircuitState | null;
} {
  // deny outranks require_approval outranks monitor, so the workspace-wide stop
  // cannot be softened by a laxer per-type breaker.
  const rank: Record<CircuitAction, number> = { monitor: 0, require_approval: 1, deny: 2 };
  let strongest: CircuitState | null = null;
  for (const b of breakers) {
    if (!strongest || rank[b.action] > rank[strongest.action]) strongest = b;
  }
  if (!strongest || strongest.action === 'monitor') return { mode: policy.mode, breaker: strongest };
  if (policy.mode === 'deny') return { mode: 'deny', breaker: strongest };
  return { mode: strongest.action, breaker: strongest };
}
