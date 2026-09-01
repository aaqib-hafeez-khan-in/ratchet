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

/** Wallets for runs nobody will look at again. Called by the retention sweep. */
export async function gcRunBudgets(db: Db = getPool(), days = 90): Promise<number> {
  const res = await db.query(
    'DELETE FROM run_budgets WHERE created_at < now() - make_interval(days => $1)', [days]);
  return res.rowCount ?? 0;
}
