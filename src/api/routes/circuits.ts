// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { stricterThan } from '../rate-limit.js';
/**
 * Circuit breakers: the surge containment controls.
 *
 * Reads and operator actions, so these take a console session or an admin key —
 * never the key-only path that `begin` and `report` use. An agent must not be
 * able to close a breaker that is holding it back; that is the entire point of
 * the control.
 */
import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { wsOf, actorOf } from '../plugins/auth.js';
import { isValidEffectType } from '../../domain/policy.js';
import {
  listCircuits, currentRates, openManually, close, ALL_EFFECT_TYPES,
  type CircuitState,
} from '../../domain/circuit.js';
import { audit } from '../../domain/audit.js';
import { circuitSchema, circuitListSchema, circuitOpenBody, errorResponses } from '../schemas.js';

const TAG = ['Circuits'];

const out = (c: CircuitState) => ({
  effect_type: c.effectType,
  state: c.state,
  action: c.action,
  tripped_at: c.trippedAt ? c.trippedAt.toISOString() : null,
  resets_at: c.resetsAt ? c.resetsAt.toISOString() : null,
  observed: c.observed,
  threshold: c.threshold,
  reason: c.reason,
  opened_by: c.openedBy,
  trip_count: c.tripCount,
});

/** `*` is legal here and nowhere else: it is the workspace-wide stop. */
function requireEffectTypeOrStar(v: string): string {
  if (v === ALL_EFFECT_TYPES) return v;
  if (!isValidEffectType(v)) {
    throw errors.invalid(
      `"${v}" is not a valid effect type. Use "*" for the whole workspace.`);
  }
  return v;
}

export default async function circuitRoutes(app: FastifyInstance) {
  app.get('/circuits', {
    preHandler: app.requireConsole('policies:read'),
    schema: {
      tags: TAG, operationId: 'listCircuits',
      summary: 'Circuit breakers and the volume they are measured against',
      description:
        'Surge containment stops an agent that has started doing far more than it used to. '
        + 'This lists every breaker the workspace has, plus the per-effect-type volume you '
        + 'would set a threshold against.',
      response: { 200: circuitListSchema, ...errorResponses },
    },
  }, async (req) => {
    const workspaceId = wsOf(req);
    const [circuits, rates] = await Promise.all([
      listCircuits(getPool(), workspaceId),
      currentRates(getPool(), workspaceId),
    ]);
    return {
      circuits: circuits.map(out),
      rates: rates.map((r) => ({
        effect_type: r.effectType, this_hour: r.thisHour, peak_hour: r.peakHour,
      })),
    };
  });

  app.post('/circuits/:effectType/open', {
    preHandler: [app.requireConsole('policies:write'), app.requireMfa()],
    // Deliberately generous: this is the control someone reaches for in a
    // panic, and a rate limit that refuses it would be indefensible.
    config: { rateLimit: stricterThan(120, '1 minute') },
    schema: {
      tags: TAG, operationId: 'openCircuit',
      summary: 'Stop an effect type now — or the whole workspace with "*"',
      description:
        'The emergency stop. Opening a breaker by hand has no cooldown: it stays open until '
        + 'a human closes it, because a control reached for in a panic must not quietly '
        + 'undo itself. Use effect type "*" to halt every effect type at once.',
      params: { type: 'object', required: ['effectType'],
        properties: { effectType: { type: 'string' } } },
      body: circuitOpenBody,
      response: { 200: circuitSchema, ...errorResponses },
    },
  }, async (req) => {
    const workspaceId = wsOf(req);
    const effectType = requireEffectTypeOrStar((req.params as { effectType: string }).effectType);
    const b = req.body as { action?: 'monitor' | 'require_approval' | 'deny'; reason: string };
    const actor = actorOf(req);
    const state = await openManually(getPool(), workspaceId, effectType, {
      action: b.action ?? 'deny', reason: b.reason, actor,
    });
    await audit(getPool(), workspaceId, 'circuit.opened', actor, effectType, {
      action: state.action, reason: b.reason,
    });
    return out(state);
  });

  app.post('/circuits/:effectType/close', {
    preHandler: [app.requireConsole('policies:write'), app.requireMfa()],
    schema: {
      tags: TAG, operationId: 'closeCircuit',
      summary: 'Close a breaker and give the effect type a fresh allowance',
      description:
        'Closing measures the surge from here on, so the effect type gets its full hourly '
        + 'allowance again rather than immediately re-tripping on volume already counted. '
        + 'The breaker still protects: a second surge opens it again.',
      params: { type: 'object', required: ['effectType'],
        properties: { effectType: { type: 'string' } } },
      response: { 200: circuitSchema, ...errorResponses },
    },
  }, async (req) => {
    const workspaceId = wsOf(req);
    const effectType = requireEffectTypeOrStar((req.params as { effectType: string }).effectType);
    const state = await close(getPool(), workspaceId, effectType);
    if (!state) throw errors.notFound(`No circuit breaker for "${effectType}".`);
    await audit(getPool(), workspaceId, 'circuit.closed', actorOf(req), effectType, {});
    return out(state);
  });
}
