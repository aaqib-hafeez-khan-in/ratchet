// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import type { Policy } from './types.js';
import { ApiError } from '../lib/errors.js';

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
  requireCost: false,
  /** Value-triggered approval is OFF unless a threshold is set. */
  approvalAboveMicros: null as number | null,
  /** Reconciliation reminders are OFF unless a cadence is set. */
  reconcileEveryHours: null as number | null,
  /** Dimensions that must be declared, or begin is refused. */
  requiredDimensions: [] as string[],
  /**
   * Per-dimension ceilings, keyed by dimension name:
   *   { counterparty: { dailyMicros: 200_000_000, dailyCount: 20 } }
   * Either may be null. A dimension with no entry here is recorded but not
   * limited, which is useful on its own — it is what makes fan-in and fan-out
   * countable later.
   */
  dimensionLimits: {} as Record<string, { dailyMicros: number | null; dailyCount: number | null }>,
  /** Observation only; see the note on Policy. */
  structuringThresholdMicros: null as number | null,
  // Surge containment is OFF unless a threshold is set. An unrequested ceiling
  // that starts refusing work is worse than no ceiling at all.
  surgePerHour: null as number | null,
  surgeAction: 'require_approval' as const,
  surgeCooldownSeconds: 3600,
  surgeMultiplier: null as number | null,
  surgeBaselinePerHour: null as number | null,
  surgeBaselineAt: null as Date | null,
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
  require_cost: boolean;
  approval_above_micros: number | null;
  reconcile_every_hours: number | null;
  required_dimensions: string[];
  dimension_limits: Record<string, { daily_micros?: number | null; daily_count?: number | null }>;
  structuring_threshold_micros: number | null;
  surge_per_hour: number | null;
  surge_action: Policy['surgeAction'];
  surge_cooldown_seconds: number;
  surge_multiplier: number | null;
  surge_baseline_per_hour: number | null;
  surge_baseline_at: Date | null;
}

/**
 * Policy is stored snake_case in JSONB and used camelCase in the domain, and
 * `src/api/serialize.ts` is the only place allowed to convert the WIRE format.
 * This is a different boundary — database JSONB to domain — so it lives here,
 * and it is defensive because the column is free-form: a hand-edited row must
 * not be able to turn a missing limit into NaN and thereby into no limit at all.
 */
/** The inverse of fromWire: domain camelCase back into the stored JSONB shape. */
function toWire(
  limits: Record<string, { dailyMicros: number | null; dailyCount: number | null }>,
): Record<string, { daily_micros: number | null; daily_count: number | null }> {
  const out: Record<string, { daily_micros: number | null; daily_count: number | null }> = {};
  for (const [name, v] of Object.entries(limits)) {
    out[name] = { daily_micros: v.dailyMicros, daily_count: v.dailyCount };
  }
  return out;
}

function fromWire(
  raw: Record<string, { daily_micros?: number | null; daily_count?: number | null }> | null,
): Record<string, { dailyMicros: number | null; dailyCount: number | null }> {
  const out: Record<string, { dailyMicros: number | null; dailyCount: number | null }> = {};
  for (const [name, v] of Object.entries(raw ?? {})) {
    const micros = typeof v?.daily_micros === 'number' && Number.isFinite(v.daily_micros)
      ? v.daily_micros : null;
    const count = typeof v?.daily_count === 'number' && Number.isFinite(v.daily_count)
      ? v.daily_count : null;
    if (micros === null && count === null) continue;   // an entry limiting nothing is not a limit
    out[name] = { dailyMicros: micros, dailyCount: count };
  }
  return out;
}

export async function getPolicy(
  db: Db, workspaceId: string, effectType: string,
): Promise<Policy> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT effect_type, mode, on_indeterminate, lease_seconds, max_attempts,
            max_cost_micros, daily_budget_micros, retention_days, require_cost,
            approval_above_micros, reconcile_every_hours,
            required_dimensions, dimension_limits, structuring_threshold_micros,
            surge_per_hour, surge_action, surge_cooldown_seconds,
            surge_multiplier, surge_baseline_per_hour, surge_baseline_at
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
    requireCost: row.require_cost,
    approvalAboveMicros: row.approval_above_micros,
    reconcileEveryHours: row.reconcile_every_hours,
    requiredDimensions: row.required_dimensions ?? [],
    dimensionLimits: fromWire(row.dimension_limits),
    structuringThresholdMicros: row.structuring_threshold_micros,
    surgePerHour: row.surge_per_hour,
    surgeAction: row.surge_action,
    surgeCooldownSeconds: row.surge_cooldown_seconds,
    surgeMultiplier: row.surge_multiplier,
    surgeBaselinePerHour: row.surge_baseline_per_hour,
    surgeBaselineAt: row.surge_baseline_at,
    isDefault: false,
  };
}

export async function listPolicies(db: Db, workspaceId: string): Promise<Policy[]> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT effect_type, mode, on_indeterminate, lease_seconds, max_attempts,
            max_cost_micros, daily_budget_micros, retention_days, require_cost,
            approval_above_micros, reconcile_every_hours,
            required_dimensions, dimension_limits, structuring_threshold_micros,
            surge_per_hour, surge_action, surge_cooldown_seconds,
            surge_multiplier, surge_baseline_per_hour, surge_baseline_at
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
    requireCost: row.require_cost,
    approvalAboveMicros: row.approval_above_micros,
    reconcileEveryHours: row.reconcile_every_hours,
    requiredDimensions: row.required_dimensions ?? [],
    dimensionLimits: fromWire(row.dimension_limits),
    structuringThresholdMicros: row.structuring_threshold_micros,
    surgePerHour: row.surge_per_hour,
    surgeAction: row.surge_action,
    surgeCooldownSeconds: row.surge_cooldown_seconds,
    surgeMultiplier: row.surge_multiplier,
    surgeBaselinePerHour: row.surge_baseline_per_hour,
    surgeBaselineAt: row.surge_baseline_at,
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
  requireCost?: boolean;
  approvalAboveMicros?: number | null;
  reconcileEveryHours?: number | null;
  requiredDimensions?: string[];
  dimensionLimits?: Record<string, { dailyMicros: number | null; dailyCount: number | null }>;
  structuringThresholdMicros?: number | null;
  surgePerHour?: number | null;
  surgeAction?: Policy['surgeAction'];
  surgeCooldownSeconds?: number;
  surgeMultiplier?: number | null;
}

export async function upsertPolicy(
  db: PoolClient | Db, workspaceId: string, input: PolicyUpsert,
): Promise<Policy> {
  const d = DEFAULT_POLICY;

  /**
   * An approval line above the refusal ceiling can never fire: max_cost_micros
   * has already refused anything that would have reached it. Storing it would
   * leave an operator reading a policy that says "approve above $20,000" while
   * every such request is rejected outright — a control that looks configured
   * and does nothing. This is a PUT, so the ceiling to compare against is the
   * one this call is establishing, not whatever happened to be there before.
   */
  const approvalAbove = input.approvalAboveMicros === undefined
    ? d.approvalAboveMicros : input.approvalAboveMicros;
  const maxCost = input.maxCostMicros ?? d.maxCostMicros;
  if (approvalAbove !== null && maxCost !== null && approvalAbove > maxCost) {
    throw new ApiError(400, 'approval_threshold_above_ceiling',
      `approval_above_micros (${approvalAbove}) is above max_cost_micros (${maxCost}), `
      + 'so it could never trigger — the ceiling refuses those requests first. '
      + 'Set the approval threshold at or below the ceiling.',
      { approvalAboveMicros: approvalAbove, maxCostMicros: maxCost });
  }

  await db.query(
    `INSERT INTO effect_policies
       (workspace_id, effect_type, mode, on_indeterminate, lease_seconds,
        max_attempts, max_cost_micros, daily_budget_micros, retention_days, require_cost,
            approval_above_micros, reconcile_every_hours,
        required_dimensions, dimension_limits, structuring_threshold_micros,
        surge_per_hour, surge_action, surge_cooldown_seconds, surge_multiplier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (workspace_id, effect_type) DO UPDATE SET
       mode                = EXCLUDED.mode,
       on_indeterminate    = EXCLUDED.on_indeterminate,
       lease_seconds       = EXCLUDED.lease_seconds,
       max_attempts        = EXCLUDED.max_attempts,
       max_cost_micros     = EXCLUDED.max_cost_micros,
       daily_budget_micros = EXCLUDED.daily_budget_micros,
       retention_days      = EXCLUDED.retention_days,
       require_cost        = EXCLUDED.require_cost,
       approval_above_micros = EXCLUDED.approval_above_micros,
       reconcile_every_hours = EXCLUDED.reconcile_every_hours,
       required_dimensions = EXCLUDED.required_dimensions,
       dimension_limits    = EXCLUDED.dimension_limits,
       structuring_threshold_micros = EXCLUDED.structuring_threshold_micros,
       surge_per_hour      = EXCLUDED.surge_per_hour,
       surge_action        = EXCLUDED.surge_action,
       surge_cooldown_seconds = EXCLUDED.surge_cooldown_seconds,
       surge_multiplier    = EXCLUDED.surge_multiplier,
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
      input.requireCost ?? d.requireCost,
      approvalAbove,
      input.reconcileEveryHours === undefined
        ? d.reconcileEveryHours : input.reconcileEveryHours,
      input.requiredDimensions ?? d.requiredDimensions,
      JSON.stringify(toWire(input.dimensionLimits ?? d.dimensionLimits)),
      input.structuringThresholdMicros === undefined
        ? d.structuringThresholdMicros : input.structuringThresholdMicros,
      input.surgePerHour === undefined ? d.surgePerHour : input.surgePerHour,
      input.surgeAction ?? d.surgeAction,
      input.surgeCooldownSeconds ?? d.surgeCooldownSeconds,
      input.surgeMultiplier === undefined ? d.surgeMultiplier : input.surgeMultiplier,
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
