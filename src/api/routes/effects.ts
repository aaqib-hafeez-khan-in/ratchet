import type { FastifyInstance } from 'fastify';
import { beginEffect, reportEffect, extendLease, resolveEffect, cancelEffect,
         decideApproval, getEffect, lookupEffect, listEffects } from '../../domain/effects.js';
import { getPool } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { config } from '../../lib/config.js';
import { wsOf, actorOf } from '../plugins/auth.js';
import { beginBody, beginResponse, reportBody, effectView, errorResponses } from '../schemas.js';
import { beginOut, effectOut, reportOut } from '../serialize.js';

const TAG = ['Effects'];

export default async function effectRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ begin
  app.post('/effects/begin', {
    // The only route reachable without a credential: with no key it provisions
    // a small anonymous workspace and hands the key back with the decision.
    preHandler: app.requireKeyOrProvision('effects:begin'),
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    schema: {
      tags: TAG,
      operationId: 'beginEffect',
      summary: 'Ask permission to perform a side effect',
      description:
        'The gate. Returns a decision that tells the caller whether to perform the action, ' +
        'replay a recorded result, wait, or stop. Call this immediately BEFORE the side effect, ' +
        'and report the outcome immediately after.',
      body: beginBody,
      response: { 200: beginResponse, ...errorResponses },
    },
  }, async (req) => {
    const auth = req.auth!;
    const b = req.body as Record<string, any>;

    const summaryBytes = Buffer.byteLength(JSON.stringify(b.request_summary ?? {}));
    if (summaryBytes > config.maxRequestBytes) {
      throw errors.payloadTooLarge('request_summary exceeds the configured size limit.');
    }

    const result = await beginEffect({
      workspaceId: auth.workspaceId,
      apiKeyId: auth.keyId,
      apiKeyPrefix: auth.keyPrefix,
      keyDailyBudgetMicros: auth.keyDailyBudgetMicros,
      effectType: b.effect_type,
      idempotencyKey: b.idempotency_key,
      payload: b.payload ?? null,
      estimatedCostMicros: b.estimated_cost_micros ?? 0,
      agentId: b.agent_id ?? null,
      runId: b.run_id ?? null,
      requestSummary: b.request_summary ?? {},
      leaseSeconds: b.lease_seconds ?? null,
      vendor: b.vendor ?? null,
      groupKey: b.group_key ?? null,
      compensation: b.compensation
        ? { effectType: b.compensation.effect_type, payload: b.compensation.payload }
        : null,
      compensatesEffectId: b.compensates_effect_id ?? null,
    });
    // Present exactly once, on the call that created the workspace. The caller
    // must store it — it is never shown again.
    return req.provisionedKey
      ? { ...beginOut(result), workspace: req.provisionedKey }
      : beginOut(result);
  });

  // ----------------------------------------------------------------- report
  app.post('/effects/:effectId/report', {
    preHandler: app.requireKey('effects:report'),
    schema: {
      tags: TAG,
      operationId: 'reportEffect',
      summary: 'Report the outcome of a leased effect',
      description:
        'Closes out an effect you hold the lease for. Reporting "succeeded" records a result ' +
        'that later duplicate callers replay instead of re-running the action. Reporting ' +
        '"failed" asserts the action did not happen, which permits a fresh attempt.',
      params: {
        type: 'object', required: ['effectId'],
        properties: { effectId: { type: 'string' } },
      },
      body: reportBody,
      response: {
        200: {
          type: 'object',
          properties: {
            effect_id: { type: 'string' },
            state: { type: 'string' },
            attempt: { type: 'integer' },
            settled_at: { type: ['string', 'null'] },
            actual_cost_micros: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const auth = req.auth!;
    const b = req.body as Record<string, any>;
    const { effectId } = req.params as { effectId: string };

    if (b.result !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(b.result));
      if (bytes > config.maxResultBytes) {
        throw errors.payloadTooLarge(
          `result exceeds the ${config.maxResultBytes}-byte limit. Store large outputs elsewhere and record a reference.`);
      }
    }

    return reportOut(await reportEffect({
      workspaceId: auth.workspaceId,
      apiKeyId: auth.keyId,
      apiKeyPrefix: auth.keyPrefix,
      effectId,
      leaseToken: b.lease_token,
      outcome: b.outcome,
      result: b.result,
      failureReason: b.failure_reason,
      actualCostMicros: b.actual_cost_micros ?? null,
    }));
  });

  // ------------------------------------------------------------------ extend
  app.post('/effects/:effectId/heartbeat', {
    preHandler: app.requireKey('effects:report'),
    schema: {
      tags: TAG, operationId: 'extendLease',
      summary: 'Tell Ratchet you are still working',
      description:
        'Extends a lease you still hold. Use it for work that may outrun its lease: keep the '
        + 'lease short so a real crash is caught quickly, and heartbeat while you are alive. '
        + 'An expired or superseded lease cannot be revived — by then the outcome is already '
        + 'recorded as unknown, and erasing that would defeat the point.',
      params: { type: 'object', required: ['effectId'], properties: { effectId: { type: 'string' } } },
      body: {
        type: 'object', required: ['lease_token'], additionalProperties: false,
        properties: {
          lease_token: { type: 'string', minLength: 8, maxLength: 128 },
          extend_seconds: { type: 'integer', minimum: 5, maximum: 3600,
            description: 'Fresh lease length from now. Clamped to the policy maximum.' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const b = req.body as { lease_token: string; extend_seconds?: number };
    const r = await extendLease({
      workspaceId: req.auth!.workspaceId,
      effectId: (req.params as { effectId: string }).effectId,
      leaseToken: b.lease_token,
      extendSeconds: b.extend_seconds ?? null,
    });
    return { effect_id: r.effectId, lease_expires_at: r.leaseExpiresAt, attempt: r.attempt };
  });

  // ---------------------------------------------------------------- resolve
  app.post('/effects/:effectId/resolve', {
    preHandler: app.requireConsole('effects:admin'),
    schema: {
      tags: TAG,
      operationId: 'resolveEffect',
      summary: 'Settle an indeterminate effect after verifying reality',
      description:
        'The escape hatch that makes a "block" policy safe: once you have checked the vendor ' +
        'and know what actually happened, record it here. The effect leaves the indeterminate ' +
        'state and normal begin() semantics resume.',
      params: { type: 'object', required: ['effectId'], properties: { effectId: { type: 'string' } } },
      body: {
        type: 'object', required: ['outcome'], additionalProperties: false,
        properties: {
          outcome: { type: 'string', enum: ['succeeded', 'failed', 'cancelled'] },
          evidence: { type: 'string', maxLength: 2048, description: 'How you verified the real-world outcome. Stored in the audit trail.' },
          result: { description: 'Recorded when outcome is "succeeded", and replayed to duplicate callers.' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const b = req.body as Record<string, any>;
    return reportOut(await resolveEffect({
      workspaceId: wsOf(req),
      effectId: (req.params as { effectId: string }).effectId,
      actor: actorOf(req),
      outcome: b.outcome,
      evidence: b.evidence,
      result: b.result,
    }));
  });

  // ----------------------------------------------------------------- cancel
  app.post('/effects/:effectId/cancel', {
    preHandler: app.requireConsole('effects:admin'),
    schema: {
      tags: TAG, operationId: 'cancelEffect',
      summary: 'Cancel an effect that has not executed',
      params: { type: 'object', required: ['effectId'], properties: { effectId: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 1024 } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const r = await cancelEffect({
      workspaceId: wsOf(req),
      effectId: (req.params as { effectId: string }).effectId,
      actor: actorOf(req), reason: b.reason,
    });
    return { effect_id: r.effectId, state: r.state };
  });

  // --------------------------------------------------------------- approval
  app.post('/effects/:effectId/approval', {
    preHandler: app.requireConsole('effects:admin'),
    schema: {
      tags: TAG, operationId: 'decideApproval',
      summary: 'Approve or reject an effect awaiting a human decision',
      params: { type: 'object', required: ['effectId'], properties: { effectId: { type: 'string' } } },
      body: {
        type: 'object', required: ['approve'], additionalProperties: false,
        properties: { approve: { type: 'boolean' }, note: { type: 'string', maxLength: 1024 } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const b = req.body as Record<string, any>;
    const r = await decideApproval({
      workspaceId: wsOf(req),
      effectId: (req.params as { effectId: string }).effectId,
      actor: actorOf(req), approve: b.approve, note: b.note,
    });
    return { effect_id: r.effectId, state: r.state };
  });

  // ------------------------------------------------------------------ reads
  app.get('/effects/:effectId', {
    preHandler: app.requireConsole('effects:read'),
    schema: {
      tags: TAG, operationId: 'getEffect', summary: 'Fetch one effect record',
      params: { type: 'object', required: ['effectId'], properties: { effectId: { type: 'string' } } },
      response: { 200: effectView, ...errorResponses },
    },
  }, async (req) => {
    const e = await getEffect(getPool(), wsOf(req),
      (req.params as { effectId: string }).effectId);
    if (!e) throw errors.notFound('No such effect in this workspace.');
    return effectOut(e);
  });

  app.get('/effects/lookup', {
    preHandler: app.requireConsole('effects:read'),
    schema: {
      tags: TAG, operationId: 'lookupEffect',
      summary: 'Look up an effect by type and idempotency key',
      description: 'A free, non-metered read. Useful for reconciling state after a crash without consuming allowance.',
      querystring: {
        type: 'object', required: ['effect_type', 'idempotency_key'],
        properties: {
          effect_type: { type: 'string' },
          idempotency_key: { type: 'string' },
        },
      },
      response: { 200: effectView, ...errorResponses },
    },
  }, async (req) => {
    const q = req.query as { effect_type: string; idempotency_key: string };
    const e = await lookupEffect(getPool(), wsOf(req), q.effect_type, q.idempotency_key);
    if (!e) throw errors.notFound('No effect recorded for that type and key.');
    return effectOut(e);
  });

  app.get('/effects', {
    preHandler: app.requireConsole('effects:read'),
    schema: {
      tags: TAG, operationId: 'listEffects', summary: 'List recent effects',
      querystring: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['awaiting_approval', 'pending', 'succeeded', 'failed', 'indeterminate', 'denied', 'cancelled'] },
          effect_type: { type: 'string' },
          run_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: effectView } },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const q = req.query as Record<string, any>;
    const list = await listEffects(getPool(), wsOf(req), {
      state: q.state, effectType: q.effect_type, runId: q.run_id, limit: q.limit,
    });
    return { data: list.map(effectOut) };
  });
}
