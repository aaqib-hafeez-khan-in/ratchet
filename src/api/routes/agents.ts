/**
 * Agent reliability: how well the callers behind this workspace actually behave.
 *
 * Reads only, and console-or-admin only. Deliberately NOT reachable with the
 * narrow agent key: an agent that can read its own report card can also learn
 * which signal to stop emitting, and every metric here is one an agent could
 * flatter by doing less. The audience is the operator.
 *
 * `agent_id` is caller-supplied and is used for grouping and nothing else. It
 * selects no policy, grants no permission and changes no decision, so a caller
 * that lies about it can only mislabel its own statistics.
 */
import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { wsOf } from '../plugins/auth.js';
import { listAgents, agentReliability, type AgentReliability } from '../../domain/agent-quality.js';
import { agentListSchema, agentReliabilitySchema, errorResponses } from '../schemas.js';

const TAG = ['Agents'];
const MAX_DAYS = 365;

/** Query windows are clamped, not rejected: a silly number is not an attack. */
function windowDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw errors.invalid('`days` must be a positive number.');
  }
  return Math.min(Math.floor(n), MAX_DAYS);
}

const out = (r: AgentReliability) => ({
  agent_id: r.agentId,
  window: { days: r.window.days, since: r.window.since },
  volume: {
    effects: r.volume.effects,
    first_seen: r.volume.firstSeen,
    last_seen: r.volume.lastSeen,
  },
  reporting: {
    concluded: r.reporting.concluded,
    reported: r.reporting.reported,
    unreported: r.reporting.unreported,
    report_rate: r.reporting.reportRate,
  },
  decisions: r.decisions,
  keys: {
    distinct_work: r.keys.distinctWork,
    work_submitted_under_several_keys: r.keys.workSubmittedUnderSeveralKeys,
    churn_rate: r.keys.churnRate,
  },
  cost: {
    measurable: r.cost.measurable,
    declared_nothing: r.cost.declaredNothing,
    median_accuracy: r.cost.medianAccuracy,
    under_declared: r.cost.underDeclared,
  },
  lease: {
    measured: r.lease.measured,
    median_hold_seconds: r.lease.medianHoldSeconds,
    p95_hold_seconds: r.lease.p95HoldSeconds,
  },
  concerns: r.concerns,
});

export default async function agentRoutes(app: FastifyInstance) {
  app.get('/agents', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: TAG, operationId: 'listAgents',
      summary: 'Agents that have used this workspace, busiest first',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, default: 30 } },
      },
      response: { 200: agentListSchema, ...errorResponses },
    },
  }, async (req) => {
    const days = windowDays((req.query as { days?: number }).days);
    const rows = await listAgents(getPool(), wsOf(req), days);
    return {
      data: rows.map((a) => ({
        agent_id: a.agentId,
        effects: a.effects,
        report_rate: a.reportRate,
        last_seen: a.lastSeen,
      })),
      window: { days },
    };
  });

  app.get('/agents/:agentId/reliability', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: TAG, operationId: 'agentReliability',
      summary: 'How reliably one agent operates: reporting, key hygiene, cost, lease hold',
      description:
        'Derived entirely from records the gate already keeps. Rates below a volume floor '
        + 'come back null rather than as a confident-looking number computed from four '
        + 'samples. There is no composite score on purpose — see `concerns` for what, if '
        + 'anything, needs attention.',
      params: {
        type: 'object', required: ['agentId'],
        properties: { agentId: { type: 'string', minLength: 1, maxLength: 128 } },
      },
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, default: 30 } },
      },
      response: { 200: agentReliabilitySchema, ...errorResponses },
    },
  }, async (req) => {
    const { agentId } = req.params as { agentId: string };
    const days = windowDays((req.query as { days?: number }).days);
    const profile = await agentReliability(getPool(), wsOf(req), agentId, days);
    // An agent this workspace has never seen is a 404 whether or not it exists
    // in someone else's workspace. Nothing here confirms it does.
    if (!profile) throw errors.notFound('No effects from that agent in this window.');
    return out(profile);
  });
}
