import { getPool } from '../db/pool.js';
import { recallRun, recallOnWire } from '../domain/recall.js';
import { receiptsFor, receiptPublicKey } from '../domain/receipts.js';
import { normalizeText } from '../lib/ids.js';
import { unwindGroup, getGroup } from '../domain/groups.js';
import { ApiError, errors } from '../lib/errors.js';
import { beginEffect, reportEffect, extendLease, resolveEffect, lookupEffect, listEffects } from '../domain/effects.js';
import { getPolicy } from '../domain/policy.js';
import { getWorkspace, requireScope, type AuthContext, type Scope } from '../domain/auth.js';
import { getSpendSummary } from '../domain/budget.js';
import { listCircuits, currentRates } from '../domain/circuit.js';
import { toolByName } from './tools.js';
import { beginOut, effectOut, reportOut, policyOut } from '../api/serialize.js';

/**
 * One dispatcher shared by the stdio and streamable-HTTP MCP transports, so a
 * tool behaves identically no matter how an agent connects. Every handler goes
 * through the same domain functions as the REST API — MCP is a second surface
 * over one implementation, never a parallel one.
 */
export async function callTool(
  ctx: AuthContext, name: string, args: Record<string, any>,
): Promise<unknown> {
  const def = toolByName.get(name);
  if (!def) throw errors.notFound(`Unknown tool "${name}".`);
  requireScope(ctx, def.scope as Scope);

  switch (name) {
    case 'ratchet_get_circuit': {
      const [circuits, rates] = await Promise.all([
        listCircuits(getPool(), ctx.workspaceId),
        currentRates(getPool(), ctx.workspaceId),
      ]);
      return {
        circuits: circuits.map((c) => ({
          effect_type: c.effectType, state: c.state, action: c.action,
          reason: c.reason, threshold: c.threshold, observed: c.observed,
          tripped_at: c.trippedAt?.toISOString() ?? null,
          resets_at: c.resetsAt?.toISOString() ?? null,
        })),
        rates: rates.map((r) => ({
          effect_type: r.effectType, this_hour: r.thisHour, peak_hour: r.peakHour,
        })),
      };
    }
    case 'ratchet_begin_effect': {
      const r = await beginEffect({
        workspaceId: ctx.workspaceId,
        apiKeyId: ctx.keyId,
        apiKeyPrefix: ctx.keyPrefix,
        keyDailyBudgetMicros: ctx.keyDailyBudgetMicros,
        effectType: args.effect_type,
        idempotencyKey: args.idempotency_key,
        payload: args.payload ?? null,
        estimatedCostMicros: args.estimated_cost_micros ?? 0,
        agentId: args.agent_id ?? null,
        runId: args.run_id ?? null,
        vendor: args.vendor ?? null,
        requestSummary: {},
        dimensions: args.dimensions ?? undefined,
        leaseSeconds: args.lease_seconds ?? null,
        groupKey: args.group_key ?? null,
        compensation: args.compensation
          ? { effectType: args.compensation.effect_type, payload: args.compensation.payload }
          : null,
        compensatesEffectId: args.compensates_effect_id ?? null,
      });
      // The `next_step` line is what keeps a model from misreading a decision.
      return { ...beginOut(r), next_step: nextStep(r.decision) };
    }

    case 'ratchet_report_effect':
      return reportOut(await reportEffect({
        workspaceId: ctx.workspaceId,
        apiKeyId: ctx.keyId,
        apiKeyPrefix: ctx.keyPrefix,
        effectId: args.effect_id,
        leaseToken: args.lease_token,
        outcome: args.outcome,
        result: args.result,
        failureReason: args.failure_reason,
        actualCostMicros: args.actual_cost_micros ?? null,
      }));

    case 'ratchet_extend_lease': {
      const r = await extendLease({
        workspaceId: ctx.workspaceId, effectId: args.effect_id,
        leaseToken: args.lease_token, extendSeconds: args.extend_seconds ?? null,
      });
      return {
        effect_id: r.effectId, lease_expires_at: r.leaseExpiresAt, attempt: r.attempt,
        next_step: 'Lease extended. Keep working, and heartbeat again before this expires.',
      };
    }

    case 'ratchet_get_effect': {
      const e = await lookupEffect(getPool(), ctx.workspaceId, args.effect_type, args.idempotency_key);
      if (!e) {
        return {
          found: false,
          note: 'No record for that effect type and key. Nothing has been gated under it yet. ' +
                'This does NOT authorise the action — call ratchet_begin_effect to proceed.',
        };
      }
      return { found: true, ...effectOut(e), next_step: checkNextStep(e.state) };
    }

    case 'ratchet_resolve_effect':
      return reportOut(await resolveEffect({
        workspaceId: ctx.workspaceId,
        effectId: args.effect_id,
        actor: `key:${ctx.keyPrefix}`,
        outcome: args.outcome,
        evidence: args.evidence,
        result: args.result,
      }));

    case 'ratchet_get_run': {
      // The same serializer the HTTP route uses, so an agent reading the
      // OpenAPI and one reading the tool see one shape.
      return recallOnWire(await recallRun(ctx.workspaceId, String(args.run_id)));
    }

    case 'ratchet_list_effects': {
      const list = await listEffects(getPool(), ctx.workspaceId, {
        state: args.state, effectType: args.effect_type,
        runId: args.run_id, limit: args.limit ?? 25,
      });
      return { count: list.length, effects: list.map(effectOut) };
    }

    case 'ratchet_get_policy':
      return policyOut(await getPolicy(getPool(), ctx.workspaceId, args.effect_type));

    case 'ratchet_unwind_group': {
      const plan = await unwindGroup({
        workspaceId: ctx.workspaceId, groupKey: args.group_key, reason: args.reason,
      });
      return planOut(plan);
    }

    case 'ratchet_get_group': {
      const plan = await getGroup(getPool(), ctx.workspaceId, args.group_key);
      if (!plan) throw errors.notFound('No such group in this workspace.');
      return planOut(plan);
    }

    case 'ratchet_list_receipts': {
      const rows = await receiptsFor(getPool(), ctx.workspaceId, args.effect_id);
      if (!rows.length) {
        return {
          effect_id: args.effect_id, receipts: [],
          note: 'No receipts for that effect in this workspace. Either it does not exist here, '
              + 'or it predates receipts. This is NOT evidence that nothing happened.',
        };
      }
      return {
        effect_id: args.effect_id,
        public_key: receiptPublicKey(),
        verify: 'ed25519_verify(public_key, body_bytes, signature). The signature covers the '
              + 'exact bytes shown in `body`.',
        receipts: rows.map((r) => ({
          seq: r.seq, decision: r.decision, attempt: r.attempt,
          body: r.body, signature: r.signature, chained: r.chained,
        })),
      };
    }

    case 'ratchet_reconcile_effects': {
      const keys: string[] = [...new Set((args.keys as string[]).map(normalizeText))];
      const { rows } = await getPool().query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM effects
          WHERE workspace_id=$1 AND effect_type=$2 AND idempotency_key = ANY($3)`,
        [ctx.workspaceId, args.effect_type, keys]);
      const seen = new Set(rows.map((r) => r.idempotency_key));
      const ungated = keys.filter((k) => !seen.has(k));
      return {
        effect_type: args.effect_type,
        checked: keys.length,
        gated: seen.size,
        ungated: ungated.length,
        ungated_keys: ungated.slice(0, 100),
        next_step: ungated.length
          ? `${ungated.length} action(s) reached the vendor without asking Ratchet. Report this `
            + 'to the operator: those code paths are unprotected and a retry there can act twice.'
          : 'Every action listed went through the gate.',
      };
    }

    case 'ratchet_get_prevented_loss': {
      const { rows } = await getPool().query<{ decision: string; n: string; micros: string }>(
        `SELECT r.decision, count(*)::text AS n,
                COALESCE(sum(r.cost_micros),0)::text AS micros
           FROM receipts r
          WHERE r.workspace_id=$1
            AND r.decision IN ('duplicate','in_flight','blocked')
            AND r.created_at > now() - interval '30 days'
          GROUP BY r.decision`, [ctx.workspaceId]);
      const refused = rows.reduce((a, r) => a + Number(r.n), 0);
      const micros = rows.reduce((a, r) => a + Number(r.micros), 0);
      return {
        window: '30 days',
        duplicate_actions_refused: refused,
        would_have_cost_micros: micros,
        would_have_cost_usd: (micros / 1e6).toFixed(2),
        note: micros === 0 && refused > 0
          ? 'Refusals happened but no cost was declared on them, so the figure reads zero. '
            + 'Pass estimated_cost_micros on ratchet_begin_effect to make this meaningful.'
          : 'Money not spent at your vendors. Counts only refusals with a declared cost, so '
            + 'the real figure is at least this.',
      };
    }

    case 'ratchet_get_usage': {
      const ws = await getWorkspace(getPool(), ctx.workspaceId);
      if (!ws) throw errors.notFound('Workspace not found.');
      const spend = await getSpendSummary(getPool(), ctx.workspaceId);
      return {
        plan: ws.plan.id,
        included_effects_per_month: ws.plan.includedEffects,
        effects_used_this_period: ws.usage.effectsThisPeriod,
        included_remaining: ws.usage.includedRemaining,
        credit_micros: ws.creditMicros,
        external_spend_today_micros: spend.workspaceMicros,
        external_spend_by_scope: spend.byScope,
      };
    }

    default:
      throw errors.notFound(`Unknown tool "${name}".`);
  }
}

function planOut(p: Awaited<ReturnType<typeof getGroup>>) {
  if (!p) return { found: false };
  return {
    group_key: p.groupKey,
    state: p.state,
    reason: p.reason,
    compensations_pending: p.steps.filter((s) => s.status === 'pending').length,
    steps: p.steps.map((s) => ({
      order: s.order,
      status: s.status,
      undo_this: s.originalEffectType,
      original_effect_id: s.originalEffectId,
      original_result: s.originalResult,
      call_begin_with: {
        effect_type: s.compensation.effectType,
        idempotency_key: s.suggestedIdempotencyKey,
        payload: s.compensation.payload,
        compensates_effect_id: s.originalEffectId,
      },
    })),
    irreversible: p.irreversible,
    unresolved: p.unresolved,
    next_step: p.nextStep,
  };
}

function nextStep(decision: string): string {
  switch (decision) {
    case 'execute':
      return 'Perform the side effect now, then call ratchet_report_effect with the lease_token.';
    case 'duplicate':
      return 'STOP. This action already completed. Use the `result` field as your outcome and do not perform the action.';
    case 'in_flight':
      return 'STOP. Another process is performing this action. Wait retry_after_seconds, then call ratchet_begin_effect again.';
    case 'blocked':
      return 'STOP. A previous attempt may or may not have taken effect. Report the uncertainty to the user, or verify at the third party and call ratchet_resolve_effect.';
    case 'approval_required':
      return 'STOP. A human operator must approve this effect. Tell the user approval is pending.';
    case 'denied':
      return 'STOP. Policy or budget refused this action. Report the reason to the user; do not attempt a workaround.';
    default:
      return 'Unrecognised decision. Do not perform the action.';
  }
}

function checkNextStep(state: string): string {
  switch (state) {
    case 'succeeded': return 'Already done. Replay the `result`; do not repeat the action.';
    case 'pending': return 'Currently leased by another caller. Do not perform it.';
    case 'indeterminate': return 'Outcome unknown. Verify at the third party before doing anything.';
    case 'failed': return 'The action did not happen. ratchet_begin_effect may grant a fresh attempt.';
    case 'denied':
    case 'cancelled': return 'Refused or cancelled. Do not perform it.';
    case 'awaiting_approval': return 'Waiting on an operator decision.';
    default: return 'Call ratchet_begin_effect to obtain an authoritative decision.';
  }
}

export function toolError(err: unknown): { message: string; code: string } {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'internal_error', message: 'Internal error.' };
}
