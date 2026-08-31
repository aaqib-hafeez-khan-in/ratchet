import type { PoolClient } from 'pg';
import { withTx, type Db } from '../db/pool.js';
import { newId, canonicalFingerprint, constantTimeEqual, normalizeText } from '../lib/ids.js';
import { ApiError, errors } from '../lib/errors.js';
import { getPolicy } from './policy.js';
import { reserveSpend, adjustSpend, BudgetExceeded } from './budget.js';
import { vendorIdempotencyKey } from './vendor-keys.js';
import { writeReceipt, RECEIPT_VERSION } from './receipts.js';
import { meterEffect, InsufficientCredit, AnonymousQuotaExhausted } from './metering.js';
import { enqueueEvent } from './events.js';
import { recordActivity, recordMilestone } from './activity.js';
import { ensureGroup, assertAcceptsWork, markCompensated, type GroupRow } from './groups.js';
import type {
  BeginInput, BeginResult, EffectRow, ReportInput, Policy, Decision,
} from './types.js';

const MIN_LEASE_SECONDS = 5;

function clampLease(requested: number | null | undefined, policy: Policy): number {
  if (!requested) return policy.leaseSeconds;
  return Math.max(MIN_LEASE_SECONDS, Math.min(requested, policy.leaseSeconds));
}

function iso(d: Date | null): string | undefined {
  return d ? d.toISOString() : undefined;
}

const SELECT_EFFECT = `
  SELECT id, workspace_id, effect_type, idempotency_key, fingerprint, state,
         attempt, lease_token, lease_expires_at, leased_by_key_id,
         reserved_micros, actual_micros, request_summary, result,
         failure_reason, denial_reason, agent_id, run_id,
         approval_state, approved_by, created_at, updated_at, settled_at, expires_at,
         group_id, compensation, compensates_effect_id, compensated_at, group_seq
    FROM effects`;

/**
 * Grant a lease on an existing effect row: bump the fencing token, reserve
 * budget, and move it to `pending`.
 */
async function grantLease(
  tx: PoolClient, effect: EffectRow, input: BeginInput, policy: Policy, now: Date,
): Promise<EffectRow> {
  const leaseSeconds = clampLease(input.leaseSeconds, policy);
  const leaseToken = newId('lt', 24);
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);

  // Release any reservation still outstanding from the previous attempt before
  // reserving afresh, so a retried effect never double-books its budget.
  if (effect.reserved_micros > 0) {
    await adjustSpend(tx, {
      workspaceId: effect.workspace_id,
      apiKeyId: effect.leased_by_key_id ?? input.apiKeyId,
      effectType: effect.effect_type,
      deltaMicros: -effect.reserved_micros,
      day: effect.created_at,
    });
  }

  await reserveSpend(tx, {
    workspaceId: input.workspaceId,
    apiKeyId: input.apiKeyId,
    effectType: input.effectType,
    amountMicros: input.estimatedCostMicros,
    workspaceDailyBudgetMicros: null,
    keyDailyBudgetMicros: input.keyDailyBudgetMicros,
    typeDailyBudgetMicros: policy.dailyBudgetMicros,
    now,
  });

  const { rows } = await tx.query<EffectRow>(
    `UPDATE effects
        SET state = 'pending', attempt = attempt + 1, lease_token = $2,
            lease_expires_at = $3, leased_by_key_id = $4,
            reserved_micros = $5, actual_micros = 0,
            failure_reason = NULL, denial_reason = NULL, updated_at = now()
      WHERE id = $1
      RETURNING id, workspace_id, effect_type, idempotency_key, fingerprint, state,
                attempt, lease_token, lease_expires_at, leased_by_key_id,
                reserved_micros, actual_micros, request_summary, result,
                failure_reason, denial_reason, agent_id, run_id,
                approval_state, approved_by, created_at, updated_at, settled_at, expires_at,
                group_id, compensation, compensates_effect_id, compensated_at, group_seq`,
    [effect.id, leaseToken, expiresAt, input.apiKeyId, input.estimatedCostMicros],
  );
  return rows[0]!;
}

async function settleAsDenied(
  tx: PoolClient, effectId: string, reason: string,
): Promise<void> {
  await tx.query(
    `UPDATE effects SET state='denied', denial_reason=$2, settled_at=now(),
            lease_token=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE id=$1`,
    [effectId, reason],
  );
}

/**
 * The gate. Decides whether the caller may perform a side effect, and records
 * that decision durably before returning it.
 */
export async function beginEffect(input: BeginInput): Promise<BeginResult> {
  const now = new Date();
  const fingerprint = canonicalFingerprint(input.payload);
  // The idempotency key is an identifier, so it is compared in NFC. Two agents
  // on different platforms writing the same key must land on the same effect.
  input = { ...input, idempotencyKey: normalizeText(input.idempotencyKey) };

  const result = await withTx(async (tx): Promise<BeginResult> => {
    // Every decision leaves evidence, not only the interesting ones. Writing it
    // here, inside the same transaction, means a decision and its receipt
    // cannot disagree: if one rolls back so does the other.
    // Fetched once, above the wrapper, because the post-decision checks below
    // need it too.
    const policy = await getPolicy(tx, input.workspaceId, input.effectType);

    const decide = async (): Promise<BeginResult> => {

    /**
     * A ceiling that nothing counts toward is not a ceiling.
     *
     * reserveSpend returns immediately when the declared amount is zero, so an
     * undeclared cost does not merely under-report — it skips the budget check
     * entirely. An operator who has configured a limit and turned this on gets
     * a refusal instead of false confidence.
     */
    if (policy.requireCost && input.estimatedCostMicros <= 0) {
      throw new ApiError(400, 'cost_required',
        `Effect type "${input.effectType}" requires a declared cost. Send `
        + 'estimated_cost_micros (micro-USD, 1e-6 USD) so budget ceilings can count it. '
        + 'Without it the ceiling on this effect type would never trigger.',
        { effectType: input.effectType });
    }

    if (policy.maxCostMicros !== null && input.estimatedCostMicros > policy.maxCostMicros) {
      throw new ApiError(403, 'cost_ceiling_exceeded',
        `Declared cost exceeds the per-effect ceiling for "${input.effectType}".`,
        { maxCostMicros: policy.maxCostMicros, requestedMicros: input.estimatedCostMicros });
    }

    const effectId = newId('eff');
    const expiresAt = new Date(now.getTime() + policy.retentionDays * 86_400_000);

    // Establish a consistent lock order before creating anything.
    //
    // Inserting an effect takes a KEY SHARE lock on the parent workspaces row
    // (that is what a foreign key does), and metering later needs that same row
    // exclusively. Two concurrent creations would therefore deadlock: each
    // holds KEY SHARE while the other waits to upgrade. Taking the exclusive
    // lock up front removes the cycle.
    //
    // The unlocked pre-check keeps this off the hot path: duplicate suppression,
    // in-flight checks, and retries all skip the workspace lock entirely,
    // because only a genuinely new effect is ever metered.
    let group: GroupRow | null = null;
    if (input.groupKey) {
      group = await ensureGroup(tx, input.workspaceId, input.groupKey,
        input.agentId ?? null, policy.retentionDays);
      // A group being rolled back must not accept new forward steps.
      assertAcceptsWork(group);
    }

    const preCheck = await tx.query<{ id: string }>(
      `SELECT id FROM effects
        WHERE workspace_id=$1 AND effect_type=$2 AND idempotency_key=$3`,
      [input.workspaceId, input.effectType, input.idempotencyKey],
    );
    if (!preCheck.rows[0]) {
      await tx.query('SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE', [input.workspaceId]);
    }

    // Atomic claim. The unique index on (workspace, type, key) is what makes
    // at-most-once possible under concurrency: exactly one caller inserts.
    const claim = await tx.query<EffectRow>(
      `INSERT INTO effects
         (id, workspace_id, effect_type, idempotency_key, fingerprint, state,
          request_summary, agent_id, run_id, expires_at,
          group_id, compensation, compensates_effect_id, group_seq)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,
               CASE WHEN $10::text IS NULL THEN NULL ELSE nextval('effect_group_seq') END)
       ON CONFLICT (workspace_id, effect_type, idempotency_key) DO NOTHING
       RETURNING id, workspace_id, effect_type, idempotency_key, fingerprint, state,
                 attempt, lease_token, lease_expires_at, leased_by_key_id,
                 reserved_micros, actual_micros, request_summary, result,
                 failure_reason, denial_reason, agent_id, run_id,
                 approval_state, approved_by, created_at, updated_at, settled_at, expires_at,
                 group_id, compensation, compensates_effect_id, compensated_at, group_seq`,
      [effectId, input.workspaceId, input.effectType, input.idempotencyKey, fingerprint,
       JSON.stringify(input.requestSummary ?? {}), input.agentId ?? null,
       input.runId ?? null, expiresAt,
       group?.id ?? null,
       input.compensation ? JSON.stringify(input.compensation) : null,
       input.compensatesEffectId ?? null],
    );

    let effect = claim.rows[0];
    const isNew = Boolean(effect);

    if (!effect) {
      // Someone else owns this key. Take the row lock and read the truth.
      const existing = await tx.query<EffectRow>(
        `${SELECT_EFFECT} WHERE workspace_id=$1 AND effect_type=$2 AND idempotency_key=$3 FOR UPDATE`,
        [input.workspaceId, input.effectType, input.idempotencyKey],
      );
      effect = existing.rows[0];
      if (!effect) {
        // The row was garbage-collected between the insert and the select.
        throw errors.conflict('retry_request',
          'Effect record changed concurrently. Retry the request.');
      }

      if (!constantTimeEqual(effect.fingerprint, fingerprint)) {
        throw errors.conflict('idempotency_key_reuse',
          'This idempotency key was already used with a different payload. ' +
          'Reusing a key for different work would hide a real, distinct effect.',
          { effectId: effect.id, effectType: effect.effect_type });
      }
    }

    // ---- New effect: apply the policy gate, then meter. --------------------
    if (isNew) {
      if (policy.mode === 'deny') {
        await settleAsDenied(tx, effect!.id, 'Policy denies this effect type.');
        return deniedResult(effect!, 'Policy denies this effect type.', null);
      }
      if (policy.mode === 'require_approval') {
        await tx.query(
          `UPDATE effects SET state='awaiting_approval', approval_state='waiting',
                  updated_at=now() WHERE id=$1`, [effect!.id],
        );
        await enqueueEvent(tx, input.workspaceId, 'effect.approval_required', {
          effectId: effect!.id, effectType: effect!.effect_type,
          idempotencyKey: effect!.idempotency_key,
          estimatedCostMicros: input.estimatedCostMicros,
          agentId: input.agentId ?? null, runId: input.runId ?? null,
        });
        const metered = await meter(tx, input, effect!.id, now);
        return {
          decision: 'approval_required' as Decision,
          effectId: effect!.id, effectType: effect!.effect_type,
          idempotencyKey: effect!.idempotency_key,
          state: 'awaiting_approval', attempt: 0,
          reason: 'An operator must approve this effect before it may run.',
          billing: metered,
        };
      }

      effect = await grantLeaseGuarded(tx, effect!, input, policy, now);
      const metered = await meter(tx, input, effect.id, now);
      return executeResult(effect, metered, input.vendor ?? undefined);
    }

    // ---- Existing effect: branch on its recorded state. --------------------
    switch (effect.state) {
      case 'succeeded':
        return {
          decision: 'duplicate' as Decision,
          effectId: effect.id, effectType: effect.effect_type,
          idempotencyKey: effect.idempotency_key,
          state: effect.state, attempt: effect.attempt,
          result: effect.result,
          reason: 'This effect already completed successfully. Replay the recorded result; do not perform it again.',
          billing: { metered: false, decisionsRemaining: null },
        };

      case 'denied':
      case 'cancelled':
        return deniedResult(effect,
          effect.denial_reason ?? (effect.state === 'cancelled'
            ? 'This effect was cancelled by an operator.'
            : 'This effect was denied.'), null);

      case 'awaiting_approval':
        if (effect.approval_state === 'approved') {
          effect = await grantLeaseGuarded(tx, effect, input, policy, now);
          return executeResult(effect, { metered: false, decisionsRemaining: null },
          input.vendor ?? undefined);
        }
        return {
          decision: 'approval_required' as Decision,
          effectId: effect.id, effectType: effect.effect_type,
          idempotencyKey: effect.idempotency_key,
          state: effect.state, attempt: effect.attempt,
          reason: 'Still waiting on an operator decision.',
          retryAfterSeconds: 15,
          billing: { metered: false, decisionsRemaining: null },
        };

      case 'pending': {
        const live = effect.lease_expires_at !== null && effect.lease_expires_at > now;
        if (live) {
          const wait = Math.max(1, Math.ceil((effect.lease_expires_at!.getTime() - now.getTime()) / 1000));
          return {
            decision: 'in_flight' as Decision,
            effectId: effect.id, effectType: effect.effect_type,
            idempotencyKey: effect.idempotency_key,
            state: effect.state, attempt: effect.attempt,
            retryAfterSeconds: wait,
            reason: 'Another caller holds a live lease on this effect. Do not perform it.',
            billing: { metered: false, decisionsRemaining: null },
          };
        }
        // Lease expired with no report. Transition it here rather than waiting
        // for the reaper; both paths hold the same row lock, so this is safe.
        effect = await markIndeterminate(tx, effect);
        return handleIndeterminate(tx, effect, input, policy, now);
      }

      case 'indeterminate':
        return handleIndeterminate(tx, effect, input, policy, now);

      case 'failed': {
        // A clean failure means the side effect provably did NOT happen, so a
        // fresh attempt is safe — subject to the attempt ceiling.
        if (effect.attempt >= policy.maxAttempts) {
          await settleAsDenied(tx, effect.id,
            `Attempt limit of ${policy.maxAttempts} reached for this idempotency key.`);
          return deniedResult(effect,
            `Attempt limit of ${policy.maxAttempts} reached for this idempotency key.`, null);
        }
        effect = await grantLeaseGuarded(tx, effect, input, policy, now);
        return executeResult(effect, { metered: false, decisionsRemaining: null },
          input.vendor ?? undefined);
      }

      default:
        throw errors.internal('Unhandled effect state.');
    }
    };

    const decided = await decide();

    // Warn where it actually matters: a limit is configured, and this call
    // declared nothing, so the limit did not count it. Silence here is how an
    // operator ends up trusting a ceiling that has never once fired.
    if (input.estimatedCostMicros <= 0
        && (policy.dailyBudgetMicros !== null || policy.maxCostMicros !== null)) {
      decided.budgetWarning =
        `A spend ceiling is configured for "${input.effectType}", but this call declared no `
        + 'cost, so nothing was counted toward it. Send estimated_cost_micros, or the '
        + 'ceiling will never trigger.';
    }

    await writeReceipt(tx, {
      v: RECEIPT_VERSION,
      workspace_id: input.workspaceId,
      effect_id: decided.effectId,
      effect_type: decided.effectType,
      idempotency_key: decided.idempotencyKey,
      decision: decided.decision,
      state: decided.state,
      attempt: decided.attempt,
      payload_fingerprint: fingerprint.toString('hex'),
      cost_micros: input.estimatedCostMicros,
      decided_at: now.toISOString(),
    });
    return decided;
  });

  if (input.groupKey) {
    result.group = { groupKey: input.groupKey, state: 'open', sequence: null };
  }

  // Analytics, after commit and fire-and-forget. Keeping this out of the
  // transaction preserves the short lock hold that begin() depends on.
  if (result.billing.metered) {
    recordActivity(input.workspaceId, 'effects_begun');
    recordMilestone(input.workspaceId, 'first_begin', { effectType: input.effectType });
  }
  if (result.state === 'indeterminate') {
    recordMilestone(input.workspaceId, 'first_indeterminate', { effectType: input.effectType });
  }
  return result;
}

async function meter(
  tx: PoolClient, input: BeginInput, effectId: string, now: Date,
): Promise<BeginResult['billing']> {
  try {
    const r = await meterEffect(tx, input.workspaceId, effectId, now);
    return { metered: true, decisionsRemaining: r.decisionsRemaining };
  } catch (err) {
    /**
     * An unclaimed workspace has spent its trial. Surfaced as its own error so
     * the route can answer with a 402 and payment terms where x402 is enabled,
     * rather than leaking as a 500 — which is what it did before this.
     */
    if (err instanceof AnonymousQuotaExhausted) {
      throw new ApiError(402, 'quota_exhausted',
        `This anonymous workspace has used its ${err.quota} free gated effects. `
        + 'Claim it with an email at POST /v1/workspaces/claim to continue on the free '
        + 'plan, or pay to continue without an account.',
        { quota: err.quota });
    }

    if (err instanceof InsufficientCredit) {
      throw errors.insufficientCredit({
        requiredMicros: err.needMicros,
        balanceMicros: err.balanceMicros,
        plan: err.plan,
        hint: 'Add prepaid credit or upgrade the plan to continue gating effects.',
      });
    }
    throw err;
  }
}

async function grantLeaseGuarded(
  tx: PoolClient, effect: EffectRow, input: BeginInput, policy: Policy, now: Date,
): Promise<EffectRow> {
  try {
    return await grantLease(tx, effect, input, policy, now);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      throw new ApiError(403, 'budget_exceeded',
        'This effect would exceed a configured daily spend budget.', {
          scope: err.check.scope,
          limitMicros: err.check.limitMicros,
          spentMicros: err.check.spentMicros,
          requestedMicros: err.check.requestedMicros,
          // Budgets bucket by UTC day, which is not local midnight for most of
          // the world. Give the caller the instant, not a rule to apply.
          resetsAt: err.check.resetsAt,
        });
    }
    throw err;
  }
}

async function markIndeterminate(tx: PoolClient, effect: EffectRow): Promise<EffectRow> {
  const { rows } = await tx.query<EffectRow>(
    `UPDATE effects
        SET state='indeterminate', lease_token=NULL, lease_expires_at=NULL,
            failure_reason='Lease expired before an outcome was reported.',
            updated_at=now()
      WHERE id=$1
      RETURNING id, workspace_id, effect_type, idempotency_key, fingerprint, state,
                attempt, lease_token, lease_expires_at, leased_by_key_id,
                reserved_micros, actual_micros, request_summary, result,
                failure_reason, denial_reason, agent_id, run_id,
                approval_state, approved_by, created_at, updated_at, settled_at, expires_at,
                group_id, compensation, compensates_effect_id, compensated_at, group_seq`,
    [effect.id],
  );
  const updated = rows[0]!;
  await enqueueEvent(tx, updated.workspace_id, 'effect.indeterminate', {
    effectId: updated.id, effectType: updated.effect_type,
    idempotencyKey: updated.idempotency_key, attempt: updated.attempt,
    agentId: updated.agent_id, runId: updated.run_id,
  });
  return updated;
}

/**
 * The heart of the honesty guarantee. A prior attempt held a lease and never
 * reported. We genuinely do not know whether the side effect reached the
 * outside world, so we refuse to pretend. What happens next is the operator's
 * declared policy for this effect type — never a silent retry.
 */
async function handleIndeterminate(
  tx: PoolClient, effect: EffectRow, input: BeginInput, policy: Policy, now: Date,
): Promise<BeginResult> {
  const prior = {
    attempt: effect.attempt,
    state: effect.state,
    startedAt: effect.created_at.toISOString(),
    lastKnownAt: effect.updated_at.toISOString(),
    onIndeterminate: policy.onIndeterminate,
  };

  if (policy.onIndeterminate === 'retry' && effect.attempt < policy.maxAttempts) {
    const leased = await grantLeaseGuarded(tx, effect, input, policy, now);
    return {
      ...executeResult(leased, { metered: false, decisionsRemaining: null },
        input.vendor ?? undefined),
      reason: 'Prior attempt was indeterminate; policy for this effect type permits a retry.',
      priorAttempt: prior,
    };
  }

  const reason = policy.onIndeterminate === 'probe'
    ? 'A prior attempt may or may not have taken effect. Verify the real-world outcome and resolve this effect explicitly before retrying.'
    : policy.onIndeterminate === 'retry'
      ? `Prior attempts were indeterminate and the attempt limit of ${policy.maxAttempts} is reached.`
      : 'A prior attempt may or may not have taken effect. Policy forbids an automatic retry.';

  return {
    decision: 'blocked',
    effectId: effect.id, effectType: effect.effect_type,
    idempotencyKey: effect.idempotency_key,
    state: effect.state, attempt: effect.attempt,
    reason, priorAttempt: prior,
    billing: { metered: false, decisionsRemaining: null },
  };
}

function executeResult(
  effect: EffectRow, billing: BeginResult['billing'], vendor?: string,
): BeginResult {
  return {
    decision: 'execute',
    effectId: effect.id,
    effectType: effect.effect_type,
    idempotencyKey: effect.idempotency_key,
    state: effect.state,
    attempt: effect.attempt,
    leaseToken: effect.lease_token!,
    leaseExpiresAt: iso(effect.lease_expires_at),
    // Derived per ATTEMPT, not per effect. A caller retrying this attempt sends
    // the same key and the vendor refuses the duplicate; a legitimate retry
    // after a reported failure is a new attempt and gets a new key, so the
    // vendor does not replay the old failure forever.
    vendorKey: vendorIdempotencyKey({
      workspaceId: effect.workspace_id,
      effectType: effect.effect_type,
      idempotencyKey: effect.idempotency_key,
      attempt: effect.attempt,
      vendor,
    }),
    reason: 'You hold the lease. Perform the effect, then report the outcome before the lease expires.',
    billing,
  };
}

function deniedResult(
  effect: EffectRow, reason: string, remaining: number | null,
): BeginResult {
  return {
    decision: 'denied',
    effectId: effect.id, effectType: effect.effect_type,
    idempotencyKey: effect.idempotency_key,
    state: 'denied', attempt: effect.attempt,
    reason,
    billing: { metered: false, decisionsRemaining: remaining },
  };
}

/**
 * Extend a lease the caller still holds — a heartbeat for slow work.
 *
 * Without this, an agent has to guess the duration up front and is punished
 * either way. Guess short and a healthy agent's effect goes `indeterminate`
 * while it is still working, and its honest report is then rejected. Guess long
 * and a genuine crash goes undetected for the whole padding.
 *
 * A heartbeat separates the two: leases stay short, so a real crash is caught
 * quickly, while an agent that is alive keeps saying so. It only ever extends —
 * an expired or superseded lease cannot be revived, because by then the effect
 * may already have been reaped and a newer attempt may hold it.
 */
export async function extendLease(args: {
  workspaceId: string; effectId: string; leaseToken: string; extendSeconds?: number | null;
}): Promise<{ effectId: string; leaseExpiresAt: string; attempt: number }> {
  const now = new Date();
  return withTx(async (tx) => {
    const { rows } = await tx.query<EffectRow>(
      `${SELECT_EFFECT} WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [args.effectId, args.workspaceId]);
    const effect = rows[0];
    if (!effect) throw errors.notFound('No such effect in this workspace.');

    if (effect.state !== 'pending') {
      throw errors.conflict('invalid_state',
        `Only a leased effect can be extended; this one is "${effect.state}".`,
        { state: effect.state });
    }
    // The fencing token still governs: a stalled holder must not be able to
    // extend a lease that has already passed to someone else.
    if (effect.lease_token !== args.leaseToken) {
      throw errors.conflict('lease_lost',
        'Your lease was superseded by a newer attempt and cannot be extended. Do not assume '
        + 'your work counted; re-run begin to learn the current state.',
        { attempt: effect.attempt });
    }
    if (effect.lease_expires_at && effect.lease_expires_at <= now) {
      throw errors.conflict('lease_expired',
        'This lease already expired, so the outcome is recorded as unknown. Extending it now '
        + 'would erase that — re-run begin to see what the policy for this effect type allows.',
        { expiredAt: effect.lease_expires_at.toISOString() });
    }

    const policy = await getPolicy(tx, args.workspaceId, effect.effect_type);
    const seconds = clampLease(args.extendSeconds, policy);
    const expiresAt = new Date(now.getTime() + seconds * 1000);

    const { rows: updated } = await tx.query<{ lease_expires_at: Date; attempt: number }>(
      `UPDATE effects SET lease_expires_at = $2, updated_at = now()
        WHERE id = $1 AND lease_token = $3
        RETURNING lease_expires_at, attempt`,
      [effect.id, expiresAt, args.leaseToken]);
    const row = updated[0]!;

    return {
      effectId: effect.id,
      leaseExpiresAt: row.lease_expires_at.toISOString(),
      attempt: row.attempt,
    };
  });
}

// --------------------------------------------------------------------- report

export interface ReportResult {
  effectId: string;
  state: EffectRow['state'];
  attempt: number;
  settledAt: string | null;
  actualCostMicros: number;
}

/**
 * Close out a leased effect. The lease token is a fencing token: a caller
 * whose lease already expired (and was reaped) cannot overwrite the newer
 * attempt's outcome.
 */
export async function reportEffect(input: ReportInput): Promise<ReportResult> {
  const now = new Date();
  return withTx(async (tx) => {
    const { rows } = await tx.query<EffectRow>(
      `${SELECT_EFFECT} WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [input.effectId, input.workspaceId],
    );
    const effect = rows[0];
    if (!effect) throw errors.notFound('No such effect in this workspace.');

    if (effect.state !== 'pending') {
      // Reporting the same outcome twice is a no-op, not an error: agents
      // retry network calls and must be able to do so safely.
      if (effect.lease_token === null && effect.settled_at !== null) {
        throw errors.conflict('lease_lost',
          `This effect is already ${effect.state}. The lease you presented is no longer valid.`,
          { state: effect.state, attempt: effect.attempt });
      }
      throw errors.conflict('invalid_state',
        `Cannot report an outcome for an effect in state "${effect.state}".`,
        { state: effect.state });
    }

    if (effect.lease_token !== input.leaseToken) {
      throw errors.conflict('lease_lost',
        'Your lease was superseded by a newer attempt. Do not assume your work counted; ' +
        're-run begin to learn the current state.',
        { attempt: effect.attempt });
    }

    if (effect.lease_expires_at && effect.lease_expires_at <= now) {
      // The lease elapsed but nobody reaped it yet. Accept the report — the
      // caller demonstrably holds the current token and knows the real outcome,
      // which is strictly better information than marking it indeterminate.
      // Recorded so operators can see leases are too short for this effect type.
      await tx.query(
        `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
         VALUES ($1,'effect.report_after_lease_expiry',$2,$3,$4)`,
        [input.workspaceId, `key:${input.apiKeyPrefix}`, effect.id,
         JSON.stringify({ lateBySeconds: Math.round((now.getTime() - effect.lease_expires_at.getTime()) / 1000) })],
      );
    }

    const actual = input.outcome === 'succeeded'
      ? (input.actualCostMicros ?? effect.reserved_micros)
      : 0;

    // Reconcile the external-spend reservation against what really happened.
    await adjustSpend(tx, {
      workspaceId: effect.workspace_id,
      apiKeyId: effect.leased_by_key_id ?? input.apiKeyId,
      effectType: effect.effect_type,
      deltaMicros: actual - effect.reserved_micros,
      day: effect.created_at,
    });

    const { rows: updated } = await tx.query<EffectRow>(
      `UPDATE effects
          SET state=$2, result=$3, failure_reason=$4, actual_micros=$5,
              reserved_micros=0, lease_token=NULL, lease_expires_at=NULL,
              settled_at=now(), updated_at=now()
        WHERE id=$1
        RETURNING id, state, attempt, settled_at, actual_micros`,
      [effect.id, input.outcome,
       input.outcome === 'succeeded' ? JSON.stringify(input.result ?? null) : null,
       input.outcome === 'failed' ? (input.failureReason ?? 'unspecified') : null,
       actual],
    );
    const row = updated[0] as unknown as {
      id: string; state: EffectRow['state']; attempt: number;
      settled_at: Date | null; actual_micros: number;
    };

    await enqueueEvent(tx, effect.workspace_id, `effect.${input.outcome}`, {
      effectId: effect.id, effectType: effect.effect_type,
      idempotencyKey: effect.idempotency_key, attempt: row.attempt,
      agentId: effect.agent_id, runId: effect.run_id,
      actualCostMicros: actual,
      failureReason: input.outcome === 'failed' ? (input.failureReason ?? 'unspecified') : null,
    });

    // A successful compensation closes out the effect it reverses, and may
    // settle the whole group.
    if (input.outcome === 'succeeded' && effect.compensates_effect_id) {
      await markCompensated(tx, effect.compensates_effect_id);
    }

    if (input.outcome === 'succeeded') {
      recordActivity(input.workspaceId, 'effects_succeeded');
      // Activation: the workspace has completed a full gated workflow.
      recordMilestone(input.workspaceId, 'first_success', { effectType: effect.effect_type });
    }

    return {
      effectId: row.id, state: row.state, attempt: row.attempt,
      settledAt: row.settled_at ? row.settled_at.toISOString() : null,
      actualCostMicros: row.actual_micros,
    };
  });
}

// -------------------------------------------------------------------- resolve

/**
 * Operator (or a verifying agent) settles an `indeterminate` effect after
 * checking what really happened at the vendor. This is the escape hatch that
 * makes a `block` policy safe to adopt: nothing is stuck forever.
 */
export async function resolveEffect(args: {
  workspaceId: string;
  effectId: string;
  actor: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  evidence?: string;
  result?: unknown;
}): Promise<ReportResult> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<EffectRow>(
      `${SELECT_EFFECT} WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [args.effectId, args.workspaceId],
    );
    const effect = rows[0];
    if (!effect) throw errors.notFound('No such effect in this workspace.');
    if (effect.state !== 'indeterminate' && effect.state !== 'awaiting_approval') {
      throw errors.conflict('invalid_state',
        `Only indeterminate or awaiting-approval effects can be resolved; this one is "${effect.state}".`,
        { state: effect.state });
    }

    if (effect.reserved_micros > 0) {
      await adjustSpend(tx, {
        workspaceId: effect.workspace_id,
        apiKeyId: effect.leased_by_key_id ?? 'unknown',
        effectType: effect.effect_type,
        deltaMicros: -effect.reserved_micros,
        day: effect.created_at,
      });
    }

    const state = args.outcome === 'cancelled' ? 'cancelled' : args.outcome;
    const { rows: updated } = await tx.query(
      `UPDATE effects
          SET state=$2, result=$3,
              failure_reason=CASE WHEN $2 IN ('failed','cancelled') THEN $4 ELSE NULL END,
              denial_reason=CASE WHEN $2='cancelled' THEN $4 ELSE NULL END,
              reserved_micros=0, lease_token=NULL, lease_expires_at=NULL,
              settled_at=now(), updated_at=now()
        WHERE id=$1
        RETURNING id, state, attempt, settled_at, actual_micros`,
      [effect.id, state,
       args.outcome === 'succeeded' ? JSON.stringify(args.result ?? null) : null,
       args.evidence ?? `Resolved as ${args.outcome} by ${args.actor}.`],
    );
    const row = updated[0] as {
      id: string; state: EffectRow['state']; attempt: number;
      settled_at: Date | null; actual_micros: number;
    };

    await tx.query(
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,'effect.resolved',$2,$3,$4)`,
      [args.workspaceId, args.actor, effect.id,
       JSON.stringify({ from: effect.state, to: state, evidence: args.evidence ?? null })],
    );

    recordMilestone(args.workspaceId, 'first_resolve', { outcome: args.outcome });

    return {
      effectId: row.id, state: row.state, attempt: row.attempt,
      settledAt: row.settled_at ? row.settled_at.toISOString() : null,
      actualCostMicros: row.actual_micros,
    };
  });
}

export async function decideApproval(args: {
  workspaceId: string; effectId: string; actor: string; approve: boolean; note?: string;
}): Promise<{ effectId: string; state: EffectRow['state'] }> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<EffectRow>(
      `${SELECT_EFFECT} WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [args.effectId, args.workspaceId],
    );
    const effect = rows[0];
    if (!effect) throw errors.notFound('No such effect in this workspace.');
    if (effect.state !== 'awaiting_approval') {
      throw errors.conflict('invalid_state',
        `Effect is "${effect.state}", not awaiting approval.`, { state: effect.state });
    }

    if (args.approve) {
      await tx.query(
        `UPDATE effects SET approval_state='approved', approved_by=$2, updated_at=now()
          WHERE id=$1`, [effect.id, args.actor],
      );
    } else {
      await tx.query(
        `UPDATE effects SET approval_state='rejected', approved_by=$2, state='denied',
                denial_reason=$3, settled_at=now(), updated_at=now()
          WHERE id=$1`,
        [effect.id, args.actor, args.note ?? 'Rejected by operator.'],
      );
    }

    await enqueueEvent(tx, args.workspaceId,
      args.approve ? 'effect.approved' : 'effect.rejected', {
        effectId: effect.id, effectType: effect.effect_type, actor: args.actor,
      });
    await tx.query(
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [args.workspaceId, args.approve ? 'effect.approved' : 'effect.rejected',
       args.actor, effect.id, JSON.stringify({ note: args.note ?? null })],
    );

    return { effectId: effect.id, state: args.approve ? 'awaiting_approval' : 'denied' };
  });
}

export async function cancelEffect(args: {
  workspaceId: string; effectId: string; actor: string; reason?: string;
}): Promise<{ effectId: string; state: EffectRow['state'] }> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<EffectRow>(
      `${SELECT_EFFECT} WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [args.effectId, args.workspaceId],
    );
    const effect = rows[0];
    if (!effect) throw errors.notFound('No such effect in this workspace.');
    if (effect.state === 'succeeded') {
      throw errors.conflict('invalid_state',
        'A succeeded effect cannot be cancelled; the real-world action already happened.');
    }
    if (effect.state === 'pending') {
      throw errors.conflict('invalid_state',
        'This effect is leased and may be executing right now. Wait for the lease to lapse, ' +
        'then resolve it once the real-world outcome is known.',
        { leaseExpiresAt: iso(effect.lease_expires_at) });
    }
    if (effect.reserved_micros > 0) {
      await adjustSpend(tx, {
        workspaceId: effect.workspace_id, apiKeyId: effect.leased_by_key_id ?? 'unknown',
        effectType: effect.effect_type, deltaMicros: -effect.reserved_micros, day: effect.created_at,
      });
    }
    await tx.query(
      `UPDATE effects SET state='cancelled', denial_reason=$2, reserved_micros=0,
              settled_at=now(), updated_at=now() WHERE id=$1`,
      [effect.id, args.reason ?? `Cancelled by ${args.actor}.`],
    );
    await tx.query(
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,'effect.cancelled',$2,$3,$4)`,
      [args.workspaceId, args.actor, effect.id, JSON.stringify({ reason: args.reason ?? null })],
    );
    return { effectId: effect.id, state: 'cancelled' };
  });
}

// ----------------------------------------------------------------- read paths

export interface EffectView {
  effectId: string; effectType: string; idempotencyKey: string;
  state: EffectRow['state']; attempt: number;
  result: unknown; failureReason: string | null; denialReason: string | null;
  agentId: string | null; runId: string | null;
  estimatedCostMicros: number; actualCostMicros: number;
  leaseExpiresAt: string | null; approvalState: string | null;
  createdAt: string; updatedAt: string; settledAt: string | null;
}

function toView(r: EffectRow): EffectView {
  return {
    effectId: r.id, effectType: r.effect_type, idempotencyKey: r.idempotency_key,
    state: r.state, attempt: r.attempt, result: r.result,
    failureReason: r.failure_reason, denialReason: r.denial_reason,
    agentId: r.agent_id, runId: r.run_id,
    estimatedCostMicros: r.reserved_micros, actualCostMicros: r.actual_micros,
    leaseExpiresAt: r.lease_expires_at ? r.lease_expires_at.toISOString() : null,
    approvalState: r.approval_state,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    settledAt: r.settled_at ? r.settled_at.toISOString() : null,
  };
}

export async function getEffect(
  db: Db, workspaceId: string, effectId: string,
): Promise<EffectView | null> {
  const { rows } = await db.query<EffectRow>(
    `${SELECT_EFFECT} WHERE id=$1 AND workspace_id=$2`, [effectId, workspaceId],
  );
  return rows[0] ? toView(rows[0]) : null;
}

export async function lookupEffect(
  db: Db, workspaceId: string, effectType: string, idempotencyKey: string,
): Promise<EffectView | null> {
  // Normalised on the same terms as the write, or a lookup from one platform
  // would fail to find the effect another platform created.
  const { rows } = await db.query<EffectRow>(
    `${SELECT_EFFECT} WHERE workspace_id=$1 AND effect_type=$2 AND idempotency_key=$3`,
    [workspaceId, effectType, normalizeText(idempotencyKey)],
  );
  return rows[0] ? toView(rows[0]) : null;
}

export async function listEffects(
  db: Db, workspaceId: string,
  filters: { state?: string; effectType?: string; runId?: string; limit?: number } = {},
): Promise<EffectView[]> {
  const clauses = ['workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  if (filters.state) { params.push(filters.state); clauses.push(`state = $${params.length}`); }
  if (filters.effectType) { params.push(filters.effectType); clauses.push(`effect_type = $${params.length}`); }
  if (filters.runId) { params.push(filters.runId); clauses.push(`run_id = $${params.length}`); }
  params.push(Math.min(filters.limit ?? 50, 200));
  const { rows } = await db.query<EffectRow>(
    `${SELECT_EFFECT} WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toView);
}
