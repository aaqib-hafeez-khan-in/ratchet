import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';

/**
 * External-spend budgets.
 *
 * These track the customer's OWN money spent at third parties (the cost an
 * agent declares for an effect, e.g. $0.0075 for an SMS). Ratchet never
 * collects this — it only enforces ceilings so a looping agent cannot burn an
 * unbounded amount. Ratchet's own fees live in `ledger_entries`.
 *
 * A `spend_windows` row holds reservations for in-flight effects plus actuals
 * for settled ones, per (scope, UTC day).
 */

export const SCOPE_WORKSPACE = 'workspace';
export const scopeForKey = (keyId: string) => `key:${keyId}`;
export const scopeForType = (effectType: string) => `type:${effectType}`;

export interface BudgetCheck {
  scope: string;
  limitMicros: number;
  spentMicros: number;
  requestedMicros: number;
  /** When this UTC-day window rolls over, so the caller can wait rather than guess. */
  resetsAt: string;
}

export class BudgetExceeded extends Error {
  constructor(readonly check: BudgetCheck) {
    super(`Daily budget for ${check.scope} would be exceeded`);
    this.name = 'BudgetExceeded';
  }
}

/**
 * Spend windows are bucketed by UTC calendar day, everywhere, for everyone.
 *
 * A local-time window would need a per-workspace timezone, and would then have
 * to answer what a "daily" budget means on the two days a year that a DST zone
 * has 23 or 25 hours — and what happens to a ceiling when a customer changes
 * their zone mid-day. UTC has one answer to all of that.
 *
 * The cost is that the window does not roll over at local midnight: a customer
 * in Tokyo sees theirs reset at 09:00, one in Los Angeles at 17:00. That is
 * only acceptable if we say so plainly, which is why every budget refusal
 * carries the exact reset instant rather than leaving the caller to guess.
 */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The instant the given UTC day's window rolls over, as an ISO string. */
export function windowResetsAt(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/**
 * Ensure the window row exists, then lock and read it.
 *
 * The insert-then-lock order matters. A plain `SELECT ... FOR UPDATE` locks
 * nothing when the row is absent, so on the first spend of a day every
 * concurrent caller would read 0 and every one of them would pass the ceiling
 * check. Materialising the row first gives us something to actually lock.
 */
async function lockAndReadSpend(
  tx: PoolClient, workspaceId: string, scope: string, day: string,
): Promise<number> {
  await tx.query(
    `INSERT INTO spend_windows (workspace_id, scope, day, spent_micros)
     VALUES ($1,$2,$3,0) ON CONFLICT (workspace_id, scope, day) DO NOTHING`,
    [workspaceId, scope, day],
  );
  const { rows } = await tx.query<{ spent_micros: number }>(
    `SELECT spent_micros FROM spend_windows
      WHERE workspace_id = $1 AND scope = $2 AND day = $3 FOR UPDATE`,
    [workspaceId, scope, day],
  );
  return rows[0]?.spent_micros ?? 0;
}

async function addSpend(
  tx: PoolClient, workspaceId: string, scope: string, day: string, delta: number,
): Promise<void> {
  if (delta === 0) return;
  await tx.query(
    `INSERT INTO spend_windows (workspace_id, scope, day, spent_micros)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, scope, day)
     DO UPDATE SET spent_micros = GREATEST(0, spend_windows.spent_micros + EXCLUDED.spent_micros)`,
    [workspaceId, scope, day, delta],
  );
}

export interface ReserveArgs {
  workspaceId: string;
  apiKeyId: string;
  effectType: string;
  amountMicros: number;
  workspaceDailyBudgetMicros: number | null;
  keyDailyBudgetMicros: number | null;
  typeDailyBudgetMicros: number | null;
  now: Date;
}

/**
 * Atomically reserve external spend against every applicable ceiling.
 * Scopes are locked in a fixed order (workspace, key, type) so concurrent
 * reservations can never deadlock against each other.
 *
 * Throws BudgetExceeded without mutating anything if any ceiling is breached.
 */
export async function reserveSpend(tx: PoolClient, args: ReserveArgs): Promise<void> {
  // Reserving nothing is a no-op: zero can never breach a ceiling, and an
  // effect that declares no cost should not be charged against one. Skipping
  // here keeps six queries off the hot path for the common case where a caller
  // has not declared a cost.
  if (args.amountMicros === 0) return;

  const day = utcDay(args.now);
  const checks: Array<{ scope: string; limit: number | null }> = [
    { scope: SCOPE_WORKSPACE, limit: args.workspaceDailyBudgetMicros },
    { scope: scopeForKey(args.apiKeyId), limit: args.keyDailyBudgetMicros },
    { scope: scopeForType(args.effectType), limit: args.typeDailyBudgetMicros },
  ];

  // Phase 1: take every lock in a fixed order and read the true committed
  // spend. Holding all three before validating any is what makes the ceiling
  // hold under concurrency.
  const spent: number[] = [];
  for (const { scope } of checks) {
    spent.push(await lockAndReadSpend(tx, args.workspaceId, scope, day));
  }
  // Phase 2: validate. Throwing here rolls back, releasing the locks.
  for (let i = 0; i < checks.length; i++) {
    const { scope, limit } = checks[i]!;
    if (limit !== null && spent[i]! + args.amountMicros > limit) {
      throw new BudgetExceeded({
        scope, limitMicros: limit, spentMicros: spent[i]!, requestedMicros: args.amountMicros,
        resetsAt: windowResetsAt(day),
      });
    }
  }
  // Phase 3: commit the reservation against every scope.
  for (const { scope } of checks) {
    await addSpend(tx, args.workspaceId, scope, day, args.amountMicros);
  }
}

/**
 * Adjust a prior reservation once the true cost is known (or release it in
 * full when the effect did not happen). `delta` may be negative.
 */
export async function adjustSpend(
  tx: PoolClient,
  args: { workspaceId: string; apiKeyId: string; effectType: string; deltaMicros: number; day: Date },
): Promise<void> {
  if (args.deltaMicros === 0) return;
  const day = utcDay(args.day);
  for (const scope of [SCOPE_WORKSPACE, scopeForKey(args.apiKeyId), scopeForType(args.effectType)]) {
    await addSpend(tx, args.workspaceId, scope, day, args.deltaMicros);
  }
}

export async function getSpendSummary(
  db: Db, workspaceId: string, now = new Date(),
): Promise<{ day: string; workspaceMicros: number; byScope: Record<string, number> }> {
  const day = utcDay(now);
  const { rows } = await db.query<{ scope: string; spent_micros: number }>(
    'SELECT scope, spent_micros FROM spend_windows WHERE workspace_id = $1 AND day = $2',
    [workspaceId, day],
  );
  const byScope: Record<string, number> = {};
  for (const r of rows) byScope[r.scope] = r.spent_micros;
  return { day, workspaceMicros: byScope[SCOPE_WORKSPACE] ?? 0, byScope };
}
