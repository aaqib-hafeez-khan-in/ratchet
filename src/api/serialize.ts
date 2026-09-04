import { effectiveCeiling } from '../domain/circuit.js';
import type { EffectView, ReportResult } from '../domain/effects.js';
import type { BeginResult, Policy } from '../domain/types.js';

/** The wire format is snake_case; the domain is camelCase. One place converts. */

export function beginOut(r: BeginResult) {
  return {
    decision: r.decision,
    effect_id: r.effectId,
    effect_type: r.effectType,
    idempotency_key: r.idempotencyKey,
    state: r.state,
    attempt: r.attempt,
    ...(r.leaseToken ? { lease_token: r.leaseToken } : {}),
    // Only ever alongside a lease. A caller who was NOT authorised must not
    // receive the key that would let the vendor accept the call anyway.
    ...(r.vendorKey ? {
      vendor_idempotency_key: {
        key: r.vendorKey.key,
        vendor: r.vendorKey.vendor,
        placement: r.vendorKey.placement,
        enforced: r.vendorKey.enforced,
        note: r.vendorKey.note,
      },
    } : {}),
    ...(r.leaseExpiresAt ? { lease_expires_at: r.leaseExpiresAt } : {}),
    ...(r.decision === 'duplicate' ? { result: r.result ?? null } : {}),
    ...(r.retryAfterSeconds ? { retry_after_seconds: r.retryAfterSeconds } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.budgetWarning ? { budget_warning: r.budgetWarning } : {}),
    ...(r.integrationWarning ? { integration_warning: r.integrationWarning } : {}),
    ...(r.priorAttempt ? {
      prior_attempt: {
        attempt: r.priorAttempt.attempt,
        state: r.priorAttempt.state,
        started_at: r.priorAttempt.startedAt,
        last_known_at: r.priorAttempt.lastKnownAt,
        on_indeterminate: r.priorAttempt.onIndeterminate,
      },
    } : {}),
    billing: {
      metered: r.billing.metered,
      included_remaining: r.billing.decisionsRemaining,
    },
    ...(r.group ? { group: { group_key: r.group.groupKey, state: r.group.state } } : {}),
  };
}

export function effectOut(e: EffectView) {
  return {
    effect_id: e.effectId,
    effect_type: e.effectType,
    idempotency_key: e.idempotencyKey,
    state: e.state,
    attempt: e.attempt,
    result: e.result ?? null,
    failure_reason: e.failureReason,
    denial_reason: e.denialReason,
    agent_id: e.agentId,
    run_id: e.runId,
    estimated_cost_micros: e.estimatedCostMicros,
    actual_cost_micros: e.actualCostMicros,
    lease_expires_at: e.leaseExpiresAt,
    approval_state: e.approvalState,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    settled_at: e.settledAt,
  };
}

export function reportOut(r: ReportResult) {
  return {
    effect_id: r.effectId,
    state: r.state,
    attempt: r.attempt,
    settled_at: r.settledAt,
    actual_cost_micros: r.actualCostMicros,
  };
}

export function policyOut(p: Policy) {
  return {
    effect_type: p.effectType,
    mode: p.mode,
    on_indeterminate: p.onIndeterminate,
    lease_seconds: p.leaseSeconds,
    max_attempts: p.maxAttempts,
    max_cost_micros: p.maxCostMicros,
    daily_budget_micros: p.dailyBudgetMicros,
    retention_days: p.retentionDays,
    // require_cost was declared in the schema but never serialised, so the API
    // silently reported nothing for a setting an operator had turned on.
    require_cost: p.requireCost,
    approval_above_micros: p.approvalAboveMicros,
    reconcile_every_hours: p.reconcileEveryHours,
    required_dimensions: p.requiredDimensions,
    structuring_threshold_micros: p.structuringThresholdMicros,
    dimension_limits: Object.fromEntries(
      Object.entries(p.dimensionLimits).map(([name, v]) => [name, {
        daily_micros: v.dailyMicros, daily_count: v.dailyCount,
      }])),
    surge_per_hour: p.surgePerHour,
    surge_action: p.surgeAction,
    surge_cooldown_seconds: p.surgeCooldownSeconds,
    surge_multiplier: p.surgeMultiplier,
    surge_baseline_per_hour: p.surgeBaselinePerHour,
    // Resolved for the caller: which of the two rules is actually in force is
    // not obvious from the inputs, and guessing it is how people end up
    // believing they are protected when they are not.
    surge_effective_ceiling: effectiveCeiling(p).ceiling,
    surge_ceiling_source: effectiveCeiling(p).source,
    is_default: p.isDefault,
  };
}
