// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
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
  /**
   * Present when what was breached was a VELOCITY ceiling rather than a spend
   * one. A caller told "budget exceeded" while having spent nothing would go
   * looking for money that was never the problem.
   */
  countLimit?: number;
  countUsed?: number;
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

async function addSpend(
  tx: PoolClient, workspaceId: string, scope: string, day: string,
  delta: number, deltaCount = 0,
): Promise<void> {
  if (delta === 0 && deltaCount === 0) return;
  await tx.query(
    `INSERT INTO spend_windows (workspace_id, scope, day, spent_micros, used_count)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, scope, day)
     DO UPDATE SET spent_micros = GREATEST(0, spend_windows.spent_micros + EXCLUDED.spent_micros),
                   used_count   = GREATEST(0, spend_windows.used_count + EXCLUDED.used_count)`,
    [workspaceId, scope, day, delta, deltaCount],
  );
}

export interface DimensionCeiling {
  /** `dim:<name>:<blinded>` — see src/lib/dimensions.ts. */
  scope: string;
  limitMicros: number | null;
  limitCount: number | null;
}

export interface ReserveArgs {
  workspaceId: string;
  apiKeyId: string;
  effectType: string;
  amountMicros: number;
  workspaceDailyBudgetMicros: number | null;
  keyDailyBudgetMicros: number | null;
  typeDailyBudgetMicros: number | null;
  /**
   * Ceilings for the dimensions this effect declared. Strictly additive: they
   * can refuse an effect the workspace, key and type ceilings would have
   * allowed, and can never permit one those refused. That is what stops a
   * caller-supplied string from widening its own authority (CLAUDE.md §6).
   */
  dimensionCeilings?: DimensionCeiling[];
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
  const dims = args.dimensionCeilings ?? [];

  // Reserving nothing used to be a flat no-op: zero can never breach a SPEND
  // ceiling. A velocity ceiling is different — "no more than five of these per
  // day" has no monetary component at all, and outbound messaging is exactly the
  // case that needs one. So the skip now also requires that nothing is counting.
  if (args.amountMicros === 0 && !dims.some((d) => d.limitCount !== null)) return;

  const day = utcDay(args.now);
  const checks: Array<{ scope: string; limit: number | null; limitCount?: number | null }> = [
    { scope: SCOPE_WORKSPACE, limit: args.workspaceDailyBudgetMicros },
    { scope: scopeForKey(args.apiKeyId), limit: args.keyDailyBudgetMicros },
    { scope: scopeForType(args.effectType), limit: args.typeDailyBudgetMicros },
    ...dims.map((d) => ({ scope: d.scope, limit: d.limitMicros, limitCount: d.limitCount })),
  ];

  /**
   * Increment every scope in one statement, then validate what came back.
   *
   * This used to be nine sequential round trips — three scopes × (materialise,
   * lock, increment) — every one of them awaited, none able to overlap. It was
   * the largest single cost on the begin path for any caller that declares a
   * cost, which the API documentation tells them to do.
   *
   * INCREMENT-THEN-VALIDATE IS SAFE HERE, AND ONLY BECAUSE OF WHERE IT RUNS.
   * `reserveSpend` is called inside begin's transaction, and a BudgetExceeded
   * propagates out of it as an ApiError — nothing catches it in a way that lets
   * the transaction commit. So the increment this statement performs is undone
   * by the same rollback that refuses the effect. Externally that is identical
   * to the old "lock, validate, increment": a refusal leaves nothing behind.
   * If that ever stops being true — if some caller catches BudgetExceeded and
   * carries on in the same transaction — this becomes a ceiling that counts the
   * spend it refused, which would ratchet a workspace shut over repeated
   * refusals. `test/integration/budget-reserve.test.ts` asserts the property
   * rather than the implementation, and would catch it.
   *
   * ORDER BY s.ord IS LOAD-BEARING. Rows are locked in the order the subquery
   * produces them, so a fixed order across concurrent callers is what keeps two
   * reservations from deadlocking on each other's scopes. Without it, row order
   * is unspecified.
   *
   * The materialise-before-lock rule (CLAUDE.md §7 rule 2) is not weakened but
   * strengthened: one atomic upsert has no window in which a row is absent and
   * a SELECT ... FOR UPDATE would lock nothing, which is the race the old
   * three-step dance existed to avoid.
   */
  const { rows } = await tx.query<{ scope: string; spent_micros: string; used_count: number }>(
    `INSERT INTO spend_windows (workspace_id, scope, day, spent_micros, used_count)
     SELECT $1, s.scope, $2, $3, 1
       FROM unnest($4::text[]) WITH ORDINALITY AS s(scope, ord)
      ORDER BY s.ord
     ON CONFLICT (workspace_id, scope, day)
     DO UPDATE SET spent_micros = spend_windows.spent_micros + EXCLUDED.spent_micros,
                   used_count   = spend_windows.used_count + EXCLUDED.used_count
     RETURNING scope, spent_micros, used_count`,
    [args.workspaceId, day, args.amountMicros, checks.map((c) => c.scope)],
  );

  // RETURNING gives the total AFTER this reservation. The ceiling is expressed
  // in terms of what was already spent, and the error reports that, so the
  // caller sees the same numbers they would have before.
  const after = new Map(rows.map((r) => [r.scope, r]));
  for (const { scope, limit, limitCount } of checks) {
    const row = after.get(scope);

    if (limit !== null) {
      const total = row ? Number(row.spent_micros) : args.amountMicros;
      if (total > limit) {
        throw new BudgetExceeded({
          scope, limitMicros: limit,
          spentMicros: total - args.amountMicros,
          requestedMicros: args.amountMicros,
          resetsAt: windowResetsAt(day),
        });
      }
    }

    if (limitCount !== undefined && limitCount !== null) {
      const used = row ? Number(row.used_count) : 1;
      if (used > limitCount) {
        throw new BudgetExceeded({
          scope, limitMicros: limit ?? 0,
          spentMicros: row ? Number(row.spent_micros) - args.amountMicros : 0,
          requestedMicros: args.amountMicros,
          resetsAt: windowResetsAt(day),
          countLimit: limitCount,
          countUsed: used - 1,
        });
      }
    }
  }
}

/**
 * Adjust a prior reservation once the true cost is known (or release it in
 * full when the effect did not happen). `delta` may be negative.
 */
export async function adjustSpend(
  tx: PoolClient,
  args: {
    workspaceId: string; apiKeyId: string; effectType: string;
    deltaMicros: number; day: Date;
    /** Scopes this effect's declared dimensions reserved against. */
    dimensionScopes?: string[];
    /**
     * -1 when releasing a reservation outright, 0 when reconciling a reported
     * cost. A retried effect releases and re-reserves, so without this a
     * velocity ceiling would count every attempt: three tries at one payment
     * would look like three payments to that counterparty. At-most-once
     * initiation says it is one payment, and the ceiling has to agree.
     */
    deltaCount?: number;
  },
): Promise<void> {
  const deltaCount = args.deltaCount ?? 0;
  if (args.deltaMicros === 0 && deltaCount === 0) return;
  const day = utcDay(args.day);
  const scopes = [
    SCOPE_WORKSPACE, scopeForKey(args.apiKeyId), scopeForType(args.effectType),
    ...(args.dimensionScopes ?? []),
  ];
  for (const scope of scopes) {
    await addSpend(tx, args.workspaceId, scope, day, args.deltaMicros, deltaCount);
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
