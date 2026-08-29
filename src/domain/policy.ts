import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import type { Policy } from './types.js';

/**
 * Applied when a workspace has not configured the effect type. Deliberately
 * conservative: unknown effect types are treated as unsafe to retry, because
 * we cannot know whether the underlying action is idempotent.
 */
export const DEFAULT_POLICY = {
  mode: 'allow' as const,
  onIndeterminate: 'block' as const,
  leaseSeconds: 60,
  maxAttempts: 3,
  maxCostMicros: null,
  dailyBudgetMicros: null,
  retentionDays: 7,
};

const EFFECT_TYPE_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

export function isValidEffectType(t: string): boolean {
  return EFFECT_TYPE_RE.test(t);
}

interface PolicyRow {
  effect_type: string;
  mode: Policy['mode'];
  on_indeterminate: Policy['onIndeterminate'];
  lease_seconds: number;
  max_attempts: number;
  max_cost_micros: number | null;
  daily_budget_micros: number | null;
  retention_days: number;
}

export async function getPolicy(
  db: Db, workspaceId: string, effectType: string,
): Promise<Policy> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT effect_type, mode, on_indeterminate, lease_seconds, max_attempts,
            max_cost_micros, daily_budget_micros, retention_days
       FROM effect_policies
      WHERE workspace_id = $1 AND effect_type = $2`,
    [workspaceId, effectType],
  );
  const row = rows[0];
  if (!row) return { workspaceId, effectType, ...DEFAULT_POLICY, isDefault: true };
  return {
    workspaceId,
    effectType: row.effect_type,
    mode: row.mode,
    onIndeterminate: row.on_indeterminate,
    leaseSeconds: row.lease_seconds,
    maxAttempts: row.max_attempts,
    maxCostMicros: row.max_cost_micros,
    dailyBudgetMicros: row.daily_budget_micros,
    retentionDays: row.retention_days,
    isDefault: false,
  };
}

export async function listPolicies(db: Db, workspaceId: string): Promise<Policy[]> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT effect_type, mode, on_indeterminate, lease_seconds, max_attempts,
            max_cost_micros, daily_budget_micros, retention_days
       FROM effect_policies WHERE workspace_id = $1 ORDER BY effect_type`,
    [workspaceId],
  );
  return rows.map((row) => ({
    workspaceId,
    effectType: row.effect_type,
    mode: row.mode,
    onIndeterminate: row.on_indeterminate,
    leaseSeconds: row.lease_seconds,
    maxAttempts: row.max_attempts,
    maxCostMicros: row.max_cost_micros,
    dailyBudgetMicros: row.daily_budget_micros,
    retentionDays: row.retention_days,
    isDefault: false,
  }));
}

export interface PolicyUpsert {
  effectType: string;
  mode?: Policy['mode'];
  onIndeterminate?: Policy['onIndeterminate'];
  leaseSeconds?: number;
  maxAttempts?: number;
  maxCostMicros?: number | null;
  dailyBudgetMicros?: number | null;
  retentionDays?: number;
}

export async function upsertPolicy(
  db: PoolClient | Db, workspaceId: string, input: PolicyUpsert,
): Promise<Policy> {
  const d = DEFAULT_POLICY;
  await db.query(
    `INSERT INTO effect_policies
       (workspace_id, effect_type, mode, on_indeterminate, lease_seconds,
        max_attempts, max_cost_micros, daily_budget_micros, retention_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, effect_type) DO UPDATE SET
       mode                = EXCLUDED.mode,
       on_indeterminate    = EXCLUDED.on_indeterminate,
       lease_seconds       = EXCLUDED.lease_seconds,
       max_attempts        = EXCLUDED.max_attempts,
       max_cost_micros     = EXCLUDED.max_cost_micros,
       daily_budget_micros = EXCLUDED.daily_budget_micros,
       retention_days      = EXCLUDED.retention_days,
       updated_at          = now()`,
    [
      workspaceId, input.effectType,
      input.mode ?? d.mode,
      input.onIndeterminate ?? d.onIndeterminate,
      input.leaseSeconds ?? d.leaseSeconds,
      input.maxAttempts ?? d.maxAttempts,
      input.maxCostMicros ?? d.maxCostMicros,
      input.dailyBudgetMicros ?? d.dailyBudgetMicros,
      input.retentionDays ?? d.retentionDays,
    ],
  );
  return getPolicy(db, workspaceId, input.effectType);
}

export async function deletePolicy(
  db: Db, workspaceId: string, effectType: string,
): Promise<boolean> {
  const res = await db.query(
    'DELETE FROM effect_policies WHERE workspace_id = $1 AND effect_type = $2',
    [workspaceId, effectType],
  );
  return (res.rowCount ?? 0) > 0;
}
