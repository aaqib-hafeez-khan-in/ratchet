// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { getPool, type Db } from '../db/pool.js';
import { getRunBudget, type RunBudget } from './run-budget.js';

/**
 * What has this run already done?
 *
 * The question an agent cannot currently answer about itself.
 *
 * An agent's memory of its own actions lives in its context window, and a
 * context window is the worst possible place to keep it. It is lossy: compaction
 * summarises it away. It is expensive: every token of recalled state is paid for
 * again on every turn. And it is unverifiable — an agent can sincerely believe
 * it pushed the commit, sent the email, made the charge, and be wrong, with no
 * way to tell. Belief and record are not the same thing, and only one of them
 * survives a restart.
 *
 * Ratchet already writes that record. Every gated effect is stamped with the run
 * it belonged to, its outcome, and its result. The record has been sitting there
 * the whole time; what was missing is a way for the agent that created it to
 * read it back at a price it can afford.
 *
 * `listEffects` can already filter by run, so this is not a new capability. It
 * is a different SHAPE. A full effect record is ~864 bytes; a twelve-step run
 * listed in full is ~10KB of context, which is a poor trade for remembering
 * something you did yourself. The digest below is ~51 bytes a step — about
 * seventeen times smaller — because a memory that costs more than re-deriving
 * the answer will not get used.
 *
 * What it deliberately surfaces separately:
 *
 *   `unknown` comes first in the caller's attention because it is the only
 *   category that can hurt. An effect whose outcome nobody knows is not a thing
 *   to skim past on the way to the summary.
 *
 *   `spentMicros` is the run's actual external spend, so an agent can see what
 *   this task has already cost at vendors without adding it up itself.
 */

export interface RecalledStep {
  /** The effect type — what was done. */
  what: string;
  /** The caller's own idempotency key, so it can match this to its plan. */
  key: string;
  outcome: 'succeeded' | 'failed' | 'pending' | 'indeterminate'
  | 'denied' | 'cancelled' | 'awaiting_approval';
  /** Present only for settled work, and only when the caller recorded one. */
  result?: unknown;
  /** Why it did not happen, when it did not. */
  reason?: string;
  at: string;
}

export interface RunRecall {
  runId: string;
  /** Settled, successful work. The things that definitely happened. */
  done: RecalledStep[];
  /** Started and not yet reported. Someone may still be holding a lease. */
  inFlight: RecalledStep[];
  /**
   * Outcome genuinely unknown. These are the ones that matter: acting around an
   * effect that may or may not have happened is how half-finished state is made.
   */
  unknown: RecalledStep[];
  /** Attempted and refused, or attempted and failed. Safe to retry or skip. */
  notDone: RecalledStep[];
  /** External spend across the run, in micro-USD. The customer's money. */
  spentMicros: number;
  /**
   * The run's wallet, when one was opened. Present here rather than behind a
   * second call because "what did I do" and "what have I got left" are one
   * question to an agent deciding what to do next, and two calls is one more
   * than it will make.
   */
  budget: RunBudget | null;
  steps: number;
  /** Plain instruction, derived from the above rather than written by hand. */
  next: string;
}

interface Row {
  effect_type: string;
  idempotency_key: string;
  state: string;
  result: unknown;
  failure_reason: string | null;
  denial_reason: string | null;
  actual_micros: number | null;
  reserved_micros: number | null;
  created_at: Date;
}

const step = (r: Row): RecalledStep => {
  const s: RecalledStep = {
    what: r.effect_type,
    key: r.idempotency_key,
    outcome: r.state as RecalledStep['outcome'],
    at: r.created_at.toISOString(),
  };
  // The result is the point of remembering a success — it is what the caller
  // would otherwise go and fetch again.
  if (r.state === 'succeeded' && r.result !== null && r.result !== undefined) {
    s.result = r.result;
  }
  const reason = r.failure_reason ?? r.denial_reason;
  if (reason) s.reason = reason;
  return s;
};

export async function recallRun(
  workspaceId: string, runId: string, db: Db = getPool(), limit = 200,
): Promise<RunRecall> {
  const { rows } = await db.query<Row>(
    `SELECT effect_type, idempotency_key, state, result, failure_reason,
            denial_reason, actual_micros, reserved_micros, created_at
       FROM effects
      WHERE workspace_id = $1 AND run_id = $2
      ORDER BY created_at ASC
      LIMIT $3`,
    [workspaceId, runId, Math.min(limit, 500)],
  );

  const done: RecalledStep[] = [];
  const inFlight: RecalledStep[] = [];
  const unknown: RecalledStep[] = [];
  const notDone: RecalledStep[] = [];
  let spentMicros = 0;

  for (const r of rows) {
    // Actual spend once reported, the reservation while still in flight — the
    // same number the budget is holding against this run right now.
    spentMicros += Number(r.actual_micros ?? 0) || Number(r.reserved_micros ?? 0);

    const s = step(r);
    if (r.state === 'succeeded') done.push(s);
    else if (r.state === 'indeterminate') unknown.push(s);
    else if (r.state === 'pending' || r.state === 'awaiting_approval') inFlight.push(s);
    else notDone.push(s);
  }

  const budget = await getRunBudget(workspaceId, runId, db);

  return {
    runId,
    budget,
    done,
    inFlight,
    unknown,
    notDone,
    spentMicros,
    steps: rows.length,
    next: guidance({ steps: rows.length, unknown, inFlight, budget }),
  };
}

/**
 * Derived, never decorative. The most dangerous state wins, because an agent
 * reading one line should be told the thing that could hurt it rather than a
 * cheerful summary that happens to be true.
 */
function guidance(
  x: {
    steps: number; unknown: RecalledStep[]; inFlight: RecalledStep[];
    budget: RunBudget | null;
  },
): string {
  if (x.steps === 0) {
    return 'Nothing has been done under this run id. If you expected work here, '
      + 'you are either resuming under a different run id or nothing was gated.';
  }
  if (x.unknown.length) {
    return `STOP. ${x.unknown.length} action(s) have an unknown outcome. Verify each `
      + 'at the vendor before doing anything that assumes it did or did not happen — '
      + 'acting around an unknown is how half-finished state is made. '
      + 'Use ratchet_resolve_effect once you know.';
  }
  if (x.inFlight.length) {
    return `${x.inFlight.length} action(s) are still in flight. Another worker may `
      + 'hold the lease. Do not repeat them; report them if they are yours.';
  }
  if (x.budget?.exhausted) {
    return 'Everything under this run is settled, but its budget is spent. Nothing '
      + 'further can be gated under this run id until someone raises the limit.';
  }
  const left = x.budget
    ? ` About ${(x.budget.remainingMicros / 1e6).toFixed(2)} USD of this run's budget remains.`
    : '';
  return 'Everything under this run is settled. Anything listed under "done" has '
    + 'already happened — use its recorded result rather than performing it again.' + left;
}

/**
 * Wire form. The domain is camelCase and the wire is snake_case, and `budget`
 * is a nested object — which is exactly where that rule gets forgotten. It was
 * forgotten here, and a test caught it. Both transports call this, so HTTP and
 * MCP cannot come to disagree about the shape.
 */
export function recallOnWire(r: RunRecall) {
  return {
    run_id: r.runId,
    steps: r.steps,
    spent_micros: r.spentMicros,
    budget: r.budget && {
      run_id: r.budget.runId,
      limit_micros: r.budget.limitMicros,
      spent_micros: r.budget.spentMicros,
      remaining_micros: r.budget.remainingMicros,
      exhausted: r.budget.exhausted,
    },
    done: r.done,
    in_flight: r.inFlight,
    unknown: r.unknown,
    not_done: r.notDone,
    next: r.next,
  };
}
