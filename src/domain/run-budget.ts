import type { PoolClient } from 'pg';
import { getPool, type Db } from '../db/pool.js';
import { errors } from '../lib/errors.js';

/**
 * A wallet for one unit of agent work.
 *
 * The existing budgets bind to an API key or an effect type and reset daily.
 * Neither is the thing anyone actually wants to bound. One key runs a thousand
 * tasks; a day is not a task; and a task that begins at 23:50 would be handed a
 * fresh allowance ten minutes later. What a person wants to say is "this job may
 * spend fifty dollars", and there was no way to say it.
 *
 * The part that matters is not the refusal. Budgets have always been able to
 * refuse. It is that **an agent can read its own remaining balance**, and an
 * agent that can see what is left behaves differently from one that can only be
 * stopped: it can take the cheaper path, batch the work, ask for approval, or
 * finish early and say why. Being refused at the moment of spending is the
 * worst time to learn a limit exists.
 *
 * On tokens, honestly: Ratchet does not see model calls and cannot meter them.
 * But the wallet holds whatever the caller declares in `estimated_cost_micros`,
 * so a caller that declares the cost of an expensive model call gets it bounded
 * here along with everything else. The ceiling is only ever as good as what
 * callers declare, which is stated wherever the number is shown.
 */

export interface RunBudget {
  runId: string;
  limitMicros: number;
  spentMicros: number;
  remainingMicros: number;
  /** True once spending has reached the ceiling. */
  exhausted: boolean;
}

const view = (r: { run_id: string; limit_micros: number; spent_micros: number }): RunBudget => {
  const limit = Number(r.limit_micros);
  const spent = Number(r.spent_micros);
  return {
    runId: r.run_id,
    limitMicros: limit,
    spentMicros: spent,
    remainingMicros: Math.max(0, limit - spent),
    exhausted: spent >= limit,
  };
};

/**
 * Open or adjust a wallet.
 *
 * Lowering a limit below what has already been spent is allowed and does not
 * claw anything back — the money is gone, and pretending otherwise would make
 * the number a fiction. It simply means nothing further may be spent.
 */
export async function setRunBudget(
  workspaceId: string, runId: string, limitMicros: number, db: Db = getPool(),
): Promise<RunBudget> {
  if (!Number.isInteger(limitMicros) || limitMicros < 0) {
    throw errors.invalid('limit_micros must be a non-negative integer.');
  }
  const { rows } = await db.query<{ run_id: string; limit_micros: number; spent_micros: number }>(
    `INSERT INTO run_budgets (workspace_id, run_id, limit_micros)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, run_id) DO UPDATE
       SET limit_micros = EXCLUDED.limit_micros, updated_at = now()
     RETURNING run_id, limit_micros, spent_micros`,
    [workspaceId, runId, limitMicros],
  );
  return view(rows[0]!);
}

/** What is left. Null when no wallet was opened — an unbudgeted run is not capped. */
export async function getRunBudget(
  workspaceId: string, runId: string, db: Db = getPool(),
): Promise<RunBudget | null> {
  const { rows } = await db.query<{ run_id: string; limit_micros: number; spent_micros: number }>(
    'SELECT run_id, limit_micros, spent_micros FROM run_budgets WHERE workspace_id = $1 AND run_id = $2',
    [workspaceId, runId],
  );
  return rows[0] ? view(rows[0]) : null;
}

export class RunBudgetExceeded extends Error {
  constructor(readonly budget: RunBudget, readonly wouldSpendMicros: number) {
    super(`Run budget for "${budget.runId}" would be exceeded`);
    this.name = 'RunBudgetExceeded';
  }
}

/**
 * Claim spend against the wallet, or refuse.
 *
 * One statement, so the check and the increment happen under the same row lock.
 * Read-then-write would let concurrent callers each observe enough headroom and
 * all pass — the same lost update that has now been fixed three times in this
 * codebase, so it is written correctly the first time here.
 *
 * No wallet means no ceiling: an unbudgeted run behaves exactly as before.
 */
export async function reserveRunSpend(
  tx: PoolClient, workspaceId: string, runId: string | null, amountMicros: number,
): Promise<void> {
  if (!runId || amountMicros <= 0) return;

  const { rows } = await tx.query<{ run_id: string; limit_micros: number; spent_micros: number }>(
    `UPDATE run_budgets
        SET spent_micros = spent_micros + $3, updated_at = now()
      WHERE workspace_id = $1 AND run_id = $2
        AND spent_micros + $3 <= limit_micros
      RETURNING run_id, limit_micros, spent_micros`,
    [workspaceId, runId, amountMicros],
  );
  if (rows[0]) return;

  // Nothing updated: either there is no wallet, or it would be exceeded. Those
  // mean opposite things, so they must be told apart rather than guessed.
  const current = await getRunBudget(workspaceId, runId, tx);
  if (!current) return;
  throw new RunBudgetExceeded(current, amountMicros);
}

/** Give back a reservation that was released — a failed attempt frees its hold. */
export async function releaseRunSpend(
  tx: PoolClient, workspaceId: string, runId: string | null, amountMicros: number,
): Promise<void> {
  if (!runId || amountMicros <= 0) return;
  await tx.query(
    `UPDATE run_budgets
        SET spent_micros = GREATEST(0, spent_micros - $3), updated_at = now()
      WHERE workspace_id = $1 AND run_id = $2`,
    [workspaceId, runId, amountMicros],
  );
}

/**
 * Every run worth showing an operator, budgeted or not.
 *
 * Listing only the runs that HAVE a wallet would be the same mistake as listing
 * only the effect types with a reconciliation cadence: it hides the answer that
 * matters. The run quietly spending four hundred dollars with no ceiling on it is
 * exactly the row you opened the page to find, and it is the one a filtered list
 * would never contain.
 *
 * Spend comes from the wallet where there is one, because that is the number the
 * gate actually enforced against. Where there is none it is summed from what
 * callers declared, and the two are labelled differently on the way out: one is a
 * ledger, the other is an estimate, and showing them as the same number would be
 * a small lie in a place that exists to prevent them.
 */
export interface RunSummary {
  runId: string;
  /** Null when no wallet was opened. */
  limitMicros: number | null;
  spentMicros: number;
  remainingMicros: number | null;
  exhausted: boolean;
  /** 'wallet' when the gate counted it; 'declared' when summed from effects. */
  spendSource: 'wallet' | 'declared';
  /**
   * Everything callers declared on this run in the window, wallet or no wallet.
   *
   * Reported alongside the wallet rather than instead of it, because a ceiling
   * opened part-way through a run starts its ledger at zero: the effects gated
   * before it existed were never counted against it. That is the honest
   * accounting, but on its own it reads as "nothing spent, plenty of room" for a
   * run that has already burned four hundred dollars. Both numbers, or the page
   * reassures in the one direction it must never reassure.
   */
  declaredMicros: number;
  effects: number;
  lastActivityAt: string | null;
  agentIds: string[];
}

export async function listRuns(
  workspaceId: string, o: { days?: number; limit?: number } = {}, db: Db = getPool(),
): Promise<RunSummary[]> {
  const days = o.days ?? 7;
  const limit = Math.min(o.limit ?? 100, 500);

  const { rows } = await db.query<{
    run_id: string; limit_micros: string | null; spent_micros: string | null;
    declared: string | null; effects: string | null; last_at: Date | null;
    agents: string[] | null;
  }>(
    `WITH seen AS (
       SELECT run_id,
              count(*)                                   AS effects,
              COALESCE(sum(declared_micros), 0)          AS declared,
              max(created_at)                            AS last_at,
              array_remove(array_agg(DISTINCT agent_id), NULL) AS agents
         FROM effects
        WHERE workspace_id = $1 AND run_id IS NOT NULL
          AND created_at > now() - make_interval(days => $2)
        GROUP BY run_id
     ),
     wallets AS (
       -- Scoped HERE, not in the join condition. In a FULL OUTER JOIN an ON
       -- predicate decides what MATCHES; it does not filter the unmatched rows
       -- the join still emits from each side. A workspace test in the ON
       -- clause therefore let every other tenant's wallets through as unmatched
       -- rows — an unscoped read path, which is the one thing §3 forbids
       -- outright. A test caught it. Both sides are narrowed to the workspace
       -- before they ever meet.
       SELECT run_id, limit_micros, spent_micros
         FROM run_budgets
        WHERE workspace_id = $1
     )
     SELECT COALESCE(s.run_id, w.run_id)  AS run_id,
            w.limit_micros, w.spent_micros,
            s.declared, s.effects, s.last_at, s.agents
       FROM seen s
       -- A wallet opened for a run that has not spent yet still belongs on the
       -- page: somebody dispatched work and set a ceiling, and seeing it is how
       -- they know it took.
       FULL OUTER JOIN wallets w ON w.run_id = s.run_id
      ORDER BY s.last_at DESC NULLS LAST, COALESCE(s.run_id, w.run_id)
      LIMIT $3`,
    [workspaceId, days, limit],
  );

  return rows.map((r) => {
    const limit_ = r.limit_micros === null ? null : Number(r.limit_micros);
    const spent = limit_ === null
      ? Number(r.declared ?? 0) : Number(r.spent_micros ?? 0);
    return {
      runId: r.run_id,
      limitMicros: limit_,
      spentMicros: spent,
      remainingMicros: limit_ === null ? null : Math.max(0, limit_ - spent),
      exhausted: limit_ !== null && spent >= limit_,
      spendSource: limit_ === null ? 'declared' as const : 'wallet' as const,
      declaredMicros: Number(r.declared ?? 0),
      effects: Number(r.effects ?? 0),
      lastActivityAt: r.last_at?.toISOString() ?? null,
      agentIds: (r.agents ?? []).slice(0, 5),
    };
  });
}

/** Wallets for runs nobody will look at again. Called by the retention sweep. */
export async function gcRunBudgets(db: Db = getPool(), days = 90): Promise<number> {
  const res = await db.query(
    'DELETE FROM run_budgets WHERE created_at < now() - make_interval(days => $1)', [days]);
  return res.rowCount ?? 0;
}
