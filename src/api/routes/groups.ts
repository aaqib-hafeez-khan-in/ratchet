// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { wsOf } from '../plugins/auth.js';
import { unwindGroup, commitGroup, getGroup, listGroups } from '../../domain/groups.js';
import { errorResponses } from '../schemas.js';

const TAG = ['Groups'];

const planSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    group_id: { type: 'string' },
    group_key: { type: 'string' },
    state: { type: 'string', enum: ['open', 'committed', 'unwinding', 'unwound', 'unwind_failed'] },
    reason: { type: ['string', 'null'] },
    steps: {
      type: 'array',
      description: 'Compensations to perform, in the order given — reverse of completion order.',
      items: { type: 'object', additionalProperties: true },
    },
    irreversible: {
      type: 'array',
      description: 'Effects that succeeded but declared no compensation. These cannot be rolled back automatically.',
      items: { type: 'object', additionalProperties: true },
    },
    unresolved: {
      type: 'array',
      description: 'Effects whose real-world outcome is unknown. Resolve these BEFORE rolling back around them.',
      items: { type: 'object', additionalProperties: true },
    },
    next_step: { type: 'string' },
  },
} as const;

export default async function groupRoutes(app: FastifyInstance) {
  app.post('/groups/:groupKey/unwind', {
    preHandler: [app.requireConsole('effects:admin'), app.requireCapability('reversibleGroups')],
    schema: {
      tags: TAG,
      operationId: 'unwindGroup',
      summary: 'Roll back a unit of work and get the compensation plan',
      description:
        'Marks the group as unwinding — it will refuse new forward steps — and returns the exact '
        + 'compensations to perform, in reverse completion order. Ratchet does not perform them: '
        + 'gate each one with begin (using its suggested idempotency key, so the undo is itself '
        + 'at-most-once), do the work, then report it.',
      params: { type: 'object', required: ['groupKey'], properties: { groupKey: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 1024 } },
      },
      response: { 200: planSchema, ...errorResponses },
    },
  }, async (req) => {
    const b = (req.body ?? {}) as { reason?: string };
    return out(await unwindGroup({
      workspaceId: wsOf(req),
      groupKey: (req.params as { groupKey: string }).groupKey,
      reason: b.reason,
    }));
  });

  app.post('/groups/:groupKey/commit', {
    preHandler: [app.requireKey('effects:report'), app.requireCapability('reversibleGroups')],
    schema: {
      tags: TAG, operationId: 'commitGroup',
      summary: 'Mark a unit of work complete',
      description: 'Records that every step succeeded. A committed group can still be unwound '
        + 'later if the outcome turns out to be wrong.',
      params: { type: 'object', required: ['groupKey'], properties: { groupKey: { type: 'string' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const r = await commitGroup({
      workspaceId: wsOf(req),
      groupKey: (req.params as { groupKey: string }).groupKey,
    });
    return { group_id: r.groupId, state: r.state };
  });

  app.get('/groups/:groupKey', {
    preHandler: [app.requireConsole('effects:read'), app.requireCapability('reversibleGroups')],
    schema: {
      tags: TAG, operationId: 'getGroup',
      summary: 'Inspect a unit of work and what remains to undo',
      params: { type: 'object', required: ['groupKey'], properties: { groupKey: { type: 'string' } } },
      response: { 200: planSchema, ...errorResponses },
    },
  }, async (req) => {
    const g = await getGroup(getPool(), wsOf(req), (req.params as { groupKey: string }).groupKey);
    if (!g) throw errors.notFound('No such group in this workspace.');
    return out(g);
  });

  app.get('/groups', {
    preHandler: [app.requireConsole('effects:read'), app.requireCapability('reversibleGroups')],
    schema: {
      tags: TAG, operationId: 'listGroups', summary: 'List recent units of work',
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => ({
    data: await listGroups(getPool(), wsOf(req), (req.query as { limit?: number }).limit ?? 50),
  }));
}

function out(p: Awaited<ReturnType<typeof getGroup>>) {
  if (!p) throw errors.notFound('No such group.');
  return {
    group_id: p.groupId,
    group_key: p.groupKey,
    state: p.state,
    reason: p.reason,
    steps: p.steps.map((s) => ({
      order: s.order,
      status: s.status,
      original_effect_id: s.originalEffectId,
      original_effect_type: s.originalEffectType,
      original_idempotency_key: s.originalIdempotencyKey,
      original_result: s.originalResult,
      compensation: { effect_type: s.compensation.effectType, payload: s.compensation.payload },
      suggested_idempotency_key: s.suggestedIdempotencyKey,
    })),
    irreversible: p.irreversible.map((i) => ({
      effect_id: i.effectId, effect_type: i.effectType,
      idempotency_key: i.idempotencyKey, result: i.result,
    })),
    unresolved: p.unresolved.map((u) => ({
      effect_id: u.effectId, effect_type: u.effectType, state: u.state,
    })),
    next_step: p.nextStep,
  };
}
