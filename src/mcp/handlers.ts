import { getPool } from '../db/pool.js';
import { ApiError, errors } from '../lib/errors.js';
import { beginEffect, reportEffect, resolveEffect, lookupEffect, listEffects } from '../domain/effects.js';
import { getPolicy } from '../domain/policy.js';
import { getWorkspace, requireScope, type AuthContext, type Scope } from '../domain/auth.js';
import { getSpendSummary } from '../domain/budget.js';
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
        requestSummary: {},
        leaseSeconds: args.lease_seconds ?? null,
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

    case 'ratchet_check_effect': {
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

    case 'ratchet_list_effects': {
      const list = await listEffects(getPool(), ctx.workspaceId, {
        state: args.state, effectType: args.effect_type,
        runId: args.run_id, limit: args.limit ?? 25,
      });
      return { count: list.length, effects: list.map(effectOut) };
    }

    case 'ratchet_get_policy':
      return policyOut(await getPolicy(getPool(), ctx.workspaceId, args.effect_type));

    case 'ratchet_usage': {
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
