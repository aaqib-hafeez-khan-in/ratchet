// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import type { PoolClient } from 'pg';
import { withTx, type Db } from '../db/pool.js';
import { newId, canonicalFingerprint, constantTimeEqual, normalizeText } from '../lib/ids.js';
import { ApiError, errors } from '../lib/errors.js';

/** Micro-USD as an operator reads it. Mirrors the formatter in structuring.ts. */
const usd = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2,
                                                    maximumFractionDigits: 2 })}`;
import { getPolicy } from './policy.js';
import { countEffect, openBreakers, trip, applyBreaker, surgeBaseline,
         effectiveCeiling } from './circuit.js';
import { reserveSpend, adjustSpend, BudgetExceeded } from './budget.js';
import { reserveRunSpend, RunBudgetExceeded } from './run-budget.js';
import { vendorIdempotencyKey } from './vendor-keys.js';
import { writeReceipt, RECEIPT_VERSION } from './receipts.js';
import { blind, scopeForDimension, type Blinded } from '../lib/dimensions.js';
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
         group_id, compensation, compensates_effect_id, compensated_at, group_seq,
         dimensions, reserved_dimension_scopes
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

  /**
   * Ceilings for what this effect declared.
   *
   * Read from the EFFECT, never from the current request. A retry arrives with
   * its own body, and taking the dimensions from it would let a caller move an
   * effect into a fresh bucket on attempt two — the exact evasion these ceilings
   * exist to stop. The row holds what was declared when the effect was created,
   * and that is what it is counted against for its whole life.
   */
  const dimensionCeilings = Object.entries(effect.dimensions ?? {})
    .map(([name, blinded]) => ({ name, scope: scopeForDimension(name, blinded) }))
    .filter(({ name }) => policy.dimensionLimits[name] !== undefined)
    .map(({ name, scope }) => ({
      scope,
      limitMicros: policy.dimensionLimits[name]!.dailyMicros,
      limitCount: policy.dimensionLimits[name]!.dailyCount,
    }));

  // Release any reservation still outstanding from the previous attempt before
  // reserving afresh, so a retried effect never double-books its budget. The
  // count goes back with it: three attempts at one payment is one payment
  // against a velocity ceiling, because at-most-once initiation says so.
  // attempt > 0 is what says a previous grant happened. reserved_micros alone is
  // not enough any more: a reported effect has had its reservation zeroed, but
  // its COUNT against a velocity ceiling is still standing and must come back
  // before the retry adds another.
  const releasing = effect.attempt > 0
    && (effect.reserved_micros > 0 || dimensionCeilings.length > 0);
  if (releasing) {
    await adjustSpend(tx, {
      workspaceId: effect.workspace_id,
      apiKeyId: effect.leased_by_key_id ?? input.apiKeyId,
      effectType: effect.effect_type,
      deltaMicros: -effect.reserved_micros,
      day: effect.created_at,
      dimensionScopes: effect.reserved_dimension_scopes ?? [],
      deltaCount: -1,
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
    dimensionCeilings,
    now,
  });

  // The task's own wallet, after the daily ceilings. A run that has spent its
  // allowance is refused here even when the day and the key still have headroom,
  // which is the point: "this job may spend fifty dollars" is a sentence nobody
  // could previously say.
  await reserveRunSpend(tx, input.workspaceId, input.runId ?? null,
    input.estimatedCostMicros);

  // lease_granted_at and declared_micros ride this UPDATE rather than a second
  // write. Neither is read on any hot path; both exist because the information
  // is destroyed otherwise -- created_at is not when permission was taken, and
  // reserved_micros is zeroed the moment the effect settles.
  const { rows } = await tx.query<EffectRow>(
    `UPDATE effects
        SET state = 'pending', attempt = attempt + 1, lease_token = $2,
            lease_expires_at = $3, leased_by_key_id = $4,
            reserved_micros = $5, actual_micros = 0, declared_micros = $5,
            lease_granted_at = now(), reserved_dimension_scopes = $6,
            failure_reason = NULL, denial_reason = NULL, updated_at = now()
      WHERE id = $1
      RETURNING id, workspace_id, effect_type, idempotency_key, fingerprint, state,
                attempt, lease_token, lease_expires_at, leased_by_key_id,
                reserved_micros, actual_micros, request_summary, result,
                failure_reason, denial_reason, agent_id, run_id,
                approval_state, approved_by, created_at, updated_at, settled_at, expires_at,
                group_id, compensation, compensates_effect_id, compensated_at, group_seq,
                dimensions, reserved_dimension_scopes`,
    [effect.id, leaseToken, expiresAt, input.apiKeyId, input.estimatedCostMicros,
     dimensionCeilings.map((d) => d.scope)],
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
/**
 * How many unreported effects a workspace may accumulate before begin says so.
 * Two is a normal amount of mid-experiment; the third is a pattern.
 */
const UNREPORTED_WARN_AT = 3;

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

    // Blinded once, up front: the required-dimension check, the INSERT and the
    // reservation must all be talking about the same values, and blinding is a
    // pure function of (workspace, name, value) so doing it here costs nothing.
    const declared: Blinded = blind(input.workspaceId, input.dimensions);

    // Assigned inside decide(), read after it. Null unless this workspace has
    // never once reported an outcome, in which case it counts the effects begun
    // here and left unreported.
    let unreported: number | null = null;

    const decide = async (): Promise<BeginResult> => {

    /**
     * A ceiling that nothing counts toward is not a ceiling.
     *
     * reserveSpend returns immediately when the declared amount is zero, so an
     * undeclared cost does not merely under-report — it skips the budget check
     * entirely. An operator who has configured a limit and turned this on gets
     * a refusal instead of false confidence.
     */
    // An approval line is a ceiling too, and the same reasoning applies: an
    // effect that declares nothing is compared against nothing and sails past a
    // threshold an operator believes is holding. So setting approval_above_micros
    // makes a declared cost mandatory whether or not require_cost was asked for.
    if (input.estimatedCostMicros <= 0
        && (policy.requireCost || policy.approvalAboveMicros !== null)) {
      throw new ApiError(400, 'cost_required',
        `Effect type "${input.effectType}" requires a declared cost. Send `
        + 'estimated_cost_micros (micro-USD, 1e-6 USD) so '
        + (policy.requireCost
          ? 'budget ceilings can count it. '
          : 'the approval threshold on this effect type can be applied. ')
        + 'Without it the '
        + (policy.requireCost ? 'ceiling' : 'threshold')
        + ' on this effect type would never trigger.',
        { effectType: input.effectType,
          requireCost: policy.requireCost,
          approvalAboveMicros: policy.approvalAboveMicros });
    }

    // A 400 rather than a `denied` decision, matching require_cost above. A
    // denial would burn the idempotency key on what is a caller bug: fix the
    // code, retry the same key, and you would replay the denial for ever.
    const missing = policy.requiredDimensions.filter((name) => !(name in declared));
    if (missing.length > 0) {
      throw new ApiError(400, 'dimension_required',
        `Effect type "${input.effectType}" requires the dimension`
        + `${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}. `
        + 'Send it in `dimensions` so the ceiling keyed on it can count this effect. '
        + 'Only a keyed hash of the value is stored — Ratchet never sees it.',
        { effectType: input.effectType, missing });
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

    // The pre-check reads the WHOLE row, and locks it when it finds one.
    //
    // It used to select only `id`, which meant a duplicate paid for three
    // queries to settle a question the first had already answered: this
    // pre-check, an INSERT guaranteed to conflict, and a second SELECT of the
    // same row to find out what it said. Measured against a local database at
    // 0.24 + 0.33 + 0.41ms — and duplicates are the COMMON path, because an
    // agent retrying is the entire situation this product exists for.
    //
    // Reading the full row under FOR UPDATE collapses the three into one. The
    // lock is the same one the third query took anyway, taken a moment earlier.
    // On a miss, FOR UPDATE matches no row and locks nothing, so the new-effect
    // path is unchanged and still takes the workspace lock first — lock order
    // remains workspaces → effects → spend_windows.
    const preCheck = await tx.query<EffectRow>(
      `${SELECT_EFFECT} WHERE workspace_id=$1 AND effect_type=$2 AND idempotency_key=$3 FOR UPDATE`,
      [input.workspaceId, input.effectType, input.idempotencyKey],
    );
    const preExisting = preCheck.rows[0];
    if (!preExisting) {
      // The workspace lock this path has always taken, now also answering the
      // one question worth asking on a brand-new integration. Both branches ride
      // effects_state_idx (workspace_id, state, ...): the EXISTS stops at the
      // first settled row, so a workspace that has ever reported pays one index
      // probe and never runs the count. No extra round trip either way.
      const ws = await tx.query<{ unreported: string | null }>(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM effects
                                   WHERE workspace_id = $1 AND state IN ('succeeded','failed'))
                     THEN NULL
                     ELSE (SELECT count(*) FROM effects
                            WHERE workspace_id = $1 AND state IN ('pending','indeterminate'))
                END AS unreported
           FROM workspaces WHERE id = $1 FOR UPDATE`,
        [input.workspaceId],
      );
      const seen = ws.rows[0]?.unreported;
      unreported = seen == null ? null : Number(seen);
    }

    // Atomic claim. The unique index on (workspace, type, key) is what makes
    // at-most-once possible under concurrency: exactly one caller inserts.
    //
    // Skipped when the pre-check already found and locked the row: the INSERT
    // could only DO NOTHING, and holding the lock means nobody can remove the
    // row between the two statements.
    const claim = preExisting ? { rows: [] as EffectRow[] } : await tx.query<EffectRow>(
      `INSERT INTO effects
         (id, workspace_id, effect_type, idempotency_key, fingerprint, state,
          request_summary, agent_id, run_id, expires_at,
          group_id, compensation, compensates_effect_id, dimensions, group_seq)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $10::text IS NULL THEN NULL ELSE nextval('effect_group_seq') END)
       ON CONFLICT (workspace_id, effect_type, idempotency_key) DO NOTHING
       RETURNING id, workspace_id, effect_type, idempotency_key, fingerprint, state,
                 attempt, lease_token, lease_expires_at, leased_by_key_id,
                 reserved_micros, actual_micros, request_summary, result,
                 failure_reason, denial_reason, agent_id, run_id,
                 approval_state, approved_by, created_at, updated_at, settled_at, expires_at,
                 group_id, compensation, compensates_effect_id, compensated_at, group_seq,
                dimensions, reserved_dimension_scopes`,
      [effectId, input.workspaceId, input.effectType, input.idempotencyKey, fingerprint,
       JSON.stringify(input.requestSummary ?? {}), input.agentId ?? null,
       input.runId ?? null, expiresAt,
       group?.id ?? null,
       input.compensation ? JSON.stringify(input.compensation) : null,
       input.compensatesEffectId ?? null,
       JSON.stringify(declared)],
    );

    let effect = claim.rows[0];
    const isNew = Boolean(effect);

    if (!effect) {
      // Either the pre-check already read and locked it, or another caller won
      // the insert race in between — and then we do have to go and read.
      effect = preExisting ?? (await tx.query<EffectRow>(
        `${SELECT_EFFECT} WHERE workspace_id=$1 AND effect_type=$2 AND idempotency_key=$3 FOR UPDATE`,
        [input.workspaceId, input.effectType, input.idempotencyKey],
      )).rows[0];
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
      /**
       * Surge containment.
       *
       * Only new effects are counted and checked. Duplicates and retries are
       * not new work in the real world, and counting them would let a caller
       * retrying a single stuck action trip its own breaker.
       *
       * The count comes from the database and the threshold from stored policy.
       * Nothing the agent sent can reach this decision — a breaker an agent
       * could talk its way past would be worse than no breaker.
       */
      const total = await countEffect(tx, input.workspaceId, input.effectType, now);
      let breakers = await openBreakers(tx, input.workspaceId, input.effectType, now);

      // Either an explicit ceiling, or one derived from this effect type's own
      // history. Reads a number already on the policy row — no extra query.
      //
      // Read BEFORE the baseline, because when there is no ceiling the baseline
      // is dead work: `observed` is used only inside the `ceiling !== null`
      // branch below. No ceiling is the default — surgePerHour and
      // surgeMultiplier are both null unless an operator sets one — so this was
      // a database round trip on the creation of most effects, to compute a
      // number nothing then read.
      const { ceiling, source, baseline } = effectiveCeiling(policy);

      // Measured from the last time this breaker was cleared, so a cooldown
      // grants a genuine fresh allowance instead of expiring straight back into
      // a re-trip on the hour's existing total.
      const observed = ceiling === null
        ? total
        : total - await surgeBaseline(tx, input.workspaceId, input.effectType, now);

      if (ceiling !== null && observed > ceiling
          && !breakers.some((b) => b.effectType === input.effectType)) {
        const reason = source === 'learned'
          ? `${observed} "${input.effectType}" effects since this breaker last cleared, `
            + `against a normal of about ${baseline} an hour — past the ${policy.surgeMultiplier}x `
            + `ceiling of ${ceiling}.`
          : `${observed} "${input.effectType}" effects since this breaker last cleared `
            + `exceeds the configured ceiling of ${ceiling} per hour.`;
        const opened = await trip(tx, input.workspaceId, input.effectType, {
          action: policy.surgeAction, observed, threshold: ceiling,
          cooldownSeconds: policy.surgeCooldownSeconds, reason, now,
        });
        await enqueueEvent(tx, input.workspaceId, 'circuit.tripped', {
          effectType: input.effectType, observed, threshold: ceiling,
          thresholdSource: source, baselinePerHour: baseline,
          action: policy.surgeAction, resetsAt: opened.resetsAt, reason,
          agentId: input.agentId ?? null, runId: input.runId ?? null,
        });
        breakers = [...breakers, opened];
      }

      // An open breaker raises the effective mode; it never lowers it.
      const { mode: breakerMode, breaker } = applyBreaker(policy, breakers);

      /**
       * So does the amount at stake, and in the same direction only.
       *
       * `mode = 'require_approval'` is per effect type: every refund waits for a
       * human or none does, which is why operators who try it turn it off again.
       * A threshold is the rule they actually have — "anything over five
       * thousand needs a second pair of eyes" — and it leaves the routine work
       * flowing.
       *
       * Raising only is what keeps this safe to key on a caller-supplied number.
       * A larger declared amount can turn `allow` into `require_approval`; no
       * declared amount can turn `require_approval` or `deny` back into `allow`.
       * A caller that under-declares to duck the threshold gets exactly what it
       * would have got had the field never existed, and lands in a receipt that
       * `POST /v1/reconcile` checks against the vendor's own record.
       */
      const overApprovalLine = policy.approvalAboveMicros !== null
        && input.estimatedCostMicros >= policy.approvalAboveMicros;
      const effectiveMode = breakerMode === 'allow' && overApprovalLine
        ? ('require_approval' as const)
        : breakerMode;

      if (effectiveMode === 'deny') {
        const why = breaker && breaker.action === 'deny'
          ? `Circuit breaker open for "${breaker.effectType}": ${breaker.reason}`
          : 'Policy denies this effect type.';
        await settleAsDenied(tx, effect!.id, why);
        return deniedResult(effect!, why, null);
      }
      if (effectiveMode === 'require_approval') {
        await tx.query(
          `UPDATE effects SET state='awaiting_approval', approval_state='waiting',
                  updated_at=now() WHERE id=$1`, [effect!.id],
        );
        // Why it is waiting, not merely that it is. An operator triaging an
        // approval queue needs the amount and the line it crossed in the
        // notification itself — having to go and look it up is how a queue
        // stops being read.
        const trigger = overApprovalLine ? 'value'
          : breaker && breaker.action === 'require_approval' ? 'circuit'
            : 'policy';
        await enqueueEvent(tx, input.workspaceId, 'effect.approval_required', {
          effectId: effect!.id, effectType: effect!.effect_type,
          idempotencyKey: effect!.idempotency_key,
          estimatedCostMicros: input.estimatedCostMicros,
          trigger,
          approvalAboveMicros: policy.approvalAboveMicros,
          agentId: input.agentId ?? null, runId: input.runId ?? null,
        });
        const metered = await meter(tx, input, effect!.id, now);
        return {
          decision: 'approval_required' as Decision,
          effectId: effect!.id, effectType: effect!.effect_type,
          idempotencyKey: effect!.idempotency_key,
          state: 'awaiting_approval', attempt: 0,
          reason: overApprovalLine
            ? `Declared cost ${usd(input.estimatedCostMicros)} is at or above the `
              + `${usd(policy.approvalAboveMicros!)} approval threshold for `
              + `"${input.effectType}". An operator must approve this effect `
              + 'before it may run.'
            : breaker && breaker.action === 'require_approval'
              ? `Circuit breaker open for "${breaker.effectType}": ${breaker.reason} `
                + 'An operator must approve this effect before it may run.'
              : 'An operator must approve this effect before it may run.',
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

    // Begin without report is the first mistake nearly every integration makes,
    // and it is free until a lease expires — at which point the call that fails
    // is a LATER one, for reasons that read like a fault in us. Say it while the
    // author is still watching, in the response they are already parsing. One
    // successful report turns this off for this workspace permanently.
    if (unreported !== null && unreported >= UNREPORTED_WARN_AT) {
      decided.integrationWarning =
        `${unreported} effects here were begun and never reported, and this workspace has `
        + 'never reported an outcome at all. Every begin needs a matching POST '
        + '/v1/effects/{effect_id}/report with the lease_token from that begin. Unreported '
        + 'effects become "indeterminate" when the lease expires, and the next attempt on '
        + 'the same idempotency_key is blocked until someone resolves it.';
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
      // Same ceiling, opposite remedies. The code stays `quota_exhausted` either
      // way so anything branching on it keeps working; only the instruction
      // differs, because only the instruction is different.
      throw new ApiError(402, 'quota_exhausted',
        err.claimed
          ? `This workspace has used its ${err.quota} free gated effects and its email `
            + 'address has not been confirmed yet. Click the link in the message we sent to '
            + 'move onto the free plan — the key and everything already recorded stay as '
            + 'they are.'
          : `This anonymous workspace has used its ${err.quota} free gated effects. `
            + 'Claim it with an email at POST /v1/workspaces/claim to continue on the free '
            + 'plan, or pay to continue without an account.',
        { quota: err.quota, awaiting_confirmation: err.claimed });
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
      // A velocity ceiling and a spend ceiling are different refusals and the
      // remedies differ, so the message says which one it was. A caller told
      // "spend budget" while having declared no cost at all would go looking for
      // money that was never the problem.
      const velocity = err.check.countLimit !== undefined;
      throw new ApiError(403, 'budget_exceeded',
        velocity
          ? `This effect would exceed a configured daily limit of ${err.check.countLimit} `
            + `effects for ${err.check.scope}.`
          : 'This effect would exceed a configured daily spend budget.', {
          scope: err.check.scope,
          limitMicros: err.check.limitMicros,
          spentMicros: err.check.spentMicros,
          requestedMicros: err.check.requestedMicros,
          ...(velocity
            ? { countLimit: err.check.countLimit, countUsed: err.check.countUsed }
            : {}),
          // Budgets bucket by UTC day, which is not local midnight for most of
          // the world. Give the caller the instant, not a rule to apply.
          resetsAt: err.check.resetsAt,
        });
    }
    if (err instanceof RunBudgetExceeded) {
      // A distinct code from the daily budgets, because the remedy is
      // different: nothing resets at midnight, so the caller either raises this
      // run's limit or accepts that the task is finished. Telling them how much
      // is left rather than only that they are over means an agent can decide
      // what to do instead of only learning it was stopped.
      throw new ApiError(403, 'run_budget_exceeded',
        `This run has spent its budget. It may spend no more than `
        + `${(err.budget.limitMicros / 1e6).toFixed(2)} USD in total.`, {
          // snake_case, per the wire contract. The sibling budget_exceeded
          // error above predates that rule and still emits camelCase; changing
          // it is a deliberate breaking change, not a drive-by, and is recorded
          // in KNOWN_LIMITATIONS.md rather than done quietly here.
          run_id: err.budget.runId,
          limit_micros: err.budget.limitMicros,
          spent_micros: err.budget.spentMicros,
          remaining_micros: err.budget.remainingMicros,
          requested_micros: err.wouldSpendMicros,
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
                group_id, compensation, compensates_effect_id, compensated_at, group_seq,
                dimensions, reserved_dimension_scopes`,
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

  /**
   * Say how to get out, not only what happened.
   *
   * This is where a new integration stalls. The usual route to being blocked is
   * that the caller began an effect and never reported it, the lease expired,
   * and now every attempt is refused — which from the outside looks like a bug
   * in us rather than a missing call in their code. Naming the likely cause and
   * the exact way out turns a dead end into an instruction.
   *
   * The path carries `effect_id`, which is in this very response, because
   * resolve is addressed by id and not by (effect_type, idempotency_key) —
   * telling somebody to use the pair would send them to a 404 while they were
   * already stuck.
   */
  const howOut =
    ` Resolve it once you know what really happened: POST /v1/effects/${effect.id}/resolve`
    + ' with {"outcome":"succeeded"} or {"outcome":"failed"}, and an "evidence" note saying'
    + ' how you checked. If this is a new integration, the usual cause is that a previous'
    + ' attempt ran but was never reported.';

  const reason = (policy.onIndeterminate === 'probe'
    ? 'A prior attempt may or may not have taken effect. Verify the real-world outcome and resolve this effect explicitly before retrying.'
    : policy.onIndeterminate === 'retry'
      ? `Prior attempts were indeterminate and the attempt limit of ${policy.maxAttempts} is reached.`
      : 'A prior attempt may or may not have taken effect. Policy forbids an automatic retry.')
    + howOut;

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
    if (!effect) throw errors.notFound('No such effect.');

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
    if (!effect) throw errors.notFound('No such effect.');

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

    // Reconcile the external-spend reservation against what really happened —
    // including the dimension buckets, or a counterparty ceiling would count
    // estimates rather than money, and under-declaring would walk past it.
    //
    // The COUNT is untouched: this effect was attempted, and a velocity ceiling
    // is counting attempts to act on a counterparty, not outcomes.
    await adjustSpend(tx, {
      workspaceId: effect.workspace_id,
      apiKeyId: effect.leased_by_key_id ?? input.apiKeyId,
      effectType: effect.effect_type,
      deltaMicros: actual - effect.reserved_micros,
      day: effect.created_at,
      dimensionScopes: effect.reserved_dimension_scopes ?? [],
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
    if (!effect) throw errors.notFound('No such effect.');
    if (effect.state !== 'indeterminate' && effect.state !== 'awaiting_approval') {
      throw errors.conflict('invalid_state',
        `Only indeterminate or awaiting-approval effects can be resolved; this one is "${effect.state}".`,
        { state: effect.state });
    }

    if (effect.reserved_micros > 0) {
      // The money comes back; the count does not. An attempt on a counterparty
      // was made, and resolving or cancelling it afterwards must not hand the
      // day's velocity allowance back — otherwise cancelling becomes the way
      // round the ceiling.
      await adjustSpend(tx, {
        workspaceId: effect.workspace_id,
        apiKeyId: effect.leased_by_key_id ?? 'unknown',
        effectType: effect.effect_type,
        deltaMicros: -effect.reserved_micros,
        day: effect.created_at,
        dimensionScopes: effect.reserved_dimension_scopes ?? [],
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
    if (!effect) throw errors.notFound('No such effect.');
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
    if (!effect) throw errors.notFound('No such effect.');
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
        dimensionScopes: effect.reserved_dimension_scopes ?? [],
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
