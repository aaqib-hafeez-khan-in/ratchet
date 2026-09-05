// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
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
import { structuringReport } from '../../domain/structuring.js';
import { fanReport } from '../../domain/fan.js';
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
    excess_keys: r.keys.excessKeys,
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
  /**
   * Amounts that crowd a threshold.
   *
   * A read, not a gate. Structuring is a property of a distribution, not of any
   * one call: a single payment at $9,800 is ordinary, and refusing it would be
   * wrong. What is not ordinary is twenty-three of them against a $10,000 line.
   * So this reports, and a human decides.
   *
   * Operator-only for the same reason the reliability profile is: an agent that
   * can see how close it is to being noticed is an agent that can adjust.
   */
  app.get('/analysis/structuring', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: TAG, operationId: 'structuringAnalysis',
      summary: 'Declared amounts that cluster just below a threshold',
      description:
        'Compares two adjacent bands below each configured threshold — the last 10% before '
        + 'it against the 10% before that. Real amounts do not crowd the final stretch before '
        + 'a line; an excess there is the classic structuring shape. A cap produces the same '
        + 'bunching honestly, so findings are somewhere to look rather than conclusions. '
        + 'Set `structuring_threshold_micros` on a policy to measure against a line Ratchet '
        + 'does NOT enforce — a reporting limit, an internal review limit — which is usually '
        + 'the line that actually gets hugged.',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, default: 30 } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const days = windowDays((req.query as { days?: number }).days);
    const r = await structuringReport(getPool(), wsOf(req), days);
    return {
      window: r.window,
      findings: r.findings.map((f) => ({
        effect_type: f.effectType,
        threshold_micros: f.thresholdMicros,
        threshold_source: f.thresholdSource,
        examined: f.examined,
        just_below: f.justBelow,
        control: f.control,
        excess_ratio: f.excessRatio,
        severity: f.severity,
        detail: f.detail,
        concentrated_in: f.concentratedIn.map((c) => ({
          dimension: c.dimension, blinded: c.blinded, count: c.count,
        })),
      })),
      examined_types: r.examinedTypes.map((t) => ({
        effect_type: t.effectType,
        threshold_micros: t.thresholdMicros,
        threshold_source: t.thresholdSource,
        examined: t.examined,
        just_below: t.justBelow,
        control: t.control,
      })),
      // Named rather than omitted: nothing found and nothing configured look
      // identical in an empty response, and they are very different answers.
      without_threshold: r.withoutThreshold,
    };
  });

  /**
   * How work spreads, and where it collects.
   *
   * A read like the structuring analysis, and operator-only for the same reason.
   * `dimension` is a caller-supplied name and travels as a bound parameter; the
   * grouping column is chosen from a fixed pair inside the domain and is never
   * built from anything a caller sent.
   */
  app.get('/analysis/fan', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: TAG, operationId: 'fanAnalysis',
      summary: 'Work spreading across destinations, and destinations collecting work',
      description:
        'Fan-out: one run or agent reaching many distinct counterparties, reported only when '
        + 'most of them are NEW — a payroll run reaches five hundred people every month and is '
        + 'the healthiest thing in the system, so cardinality alone says nothing and novelty is '
        + 'the measure. Fan-in: one counterparty collecting from several separate agents, which '
        + 'no per-agent ceiling can see. Neither is a verdict: a first run of anything is one '
        + 'hundred per cent new counterparties and looks identical to the thing this finds.',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, default: 30 },
          dimension: {
            type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$', default: 'counterparty',
            description: 'Which declared dimension to count across.',
          },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const q = req.query as { days?: number; dimension?: string };
    const days = windowDays(q.days);
    const r = await fanReport(getPool(), wsOf(req), q.dimension ?? 'counterparty', days);
    return {
      window: r.window,
      dimension: r.dimension,
      counterparties_in_window: r.counterpartiesInWindow,
      fan_out: r.fanOut.map((f) => ({
        grouping: f.grouping, id: f.id,
        distinct_counterparties: f.distinctCounterparties,
        first_seen: f.firstSeen,
        new_share: f.newShare,
        effects: f.effects,
        severity: f.severity,
        detail: f.detail,
      })),
      fan_in: r.fanIn.map((f) => ({
        blinded: f.blinded,
        distinct_agents: f.distinctAgents,
        distinct_runs: f.distinctRuns,
        effects: f.effects,
        severity: f.severity,
        detail: f.detail,
      })),
    };
  });

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
        concluded: a.concluded,
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
