// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { getPool, type Db } from '../db/pool.js';

/**
 * How well is an agent actually behaving?
 *
 * Everyone benchmarks agents on whether they finish a task. Ratchet sits
 * somewhere nobody else does — between an agent's intention and the real world,
 * in production, while things are failing — and that vantage point makes a
 * different question answerable: does this agent operate safely when it is not
 * being watched.
 *
 * Every number here is derived from data the gate already keeps. Nothing is
 * inferred, and nothing is written for this purpose beyond two columns that ride
 * an UPDATE the lease path was making anyway.
 *
 * WHY THERE IS NO SINGLE SCORE. A composite invites two failures. It hides the
 * mechanism, so an operator learns their agent is "72" and not that it stopped
 * reporting outcomes last Tuesday; and it invites gaming, because the cheapest
 * way to raise a blended number is usually to stop emitting the signal that
 * drags it down. What comes back instead is the measurements and, where a
 * threshold is crossed with enough volume behind it, a plain sentence about what
 * that means. Concerns are ordered worst first.
 *
 * WHY SOME FIELDS COME BACK NULL. Below a volume floor these numbers are noise,
 * and a noisy number presented confidently is worse than no number. A metric
 * that cannot be computed honestly says so.
 */

/** Below this many observations a rate is noise, and is reported as null. */
const FLOOR = 20;

/** Same idea, lower bar: cost and lease samples are rarer and still useful. */
const SAMPLE_FLOOR = 5;

export interface AgentReliability {
  agentId: string;
  window: { days: number; since: string };
  /** Effects this agent created in the window, and when it was last seen. */
  volume: { effects: number; firstSeen: string | null; lastSeen: string | null };
  /**
   * The headline. An effect whose lease ended without a report is
   * `indeterminate`: the agent took permission to act and never came back to say
   * what happened. It is the single most informative number about an agent,
   * because it is what the outside world cannot tell you.
   */
  reporting: {
    concluded: number;
    reported: number;
    unreported: number;
    reportRate: number | null;
  };
  /**
   * What `begin` actually returned, from the receipt of every call — including
   * the calls that created no effect, which is where retry behaviour shows up.
   */
  decisions: Record<string, number>;
  /**
   * Idempotency key hygiene, which only a service holding payload fingerprints
   * can see. Identical work submitted under several keys is the tell of an agent
   * minting a key per attempt — a UUID, a timestamp — so the gate sees new work
   * every time and permits it. It looks like it is using Ratchet. It is not.
   *
   * It is a hint rather than a verdict, because a deliberate repeat looks
   * identical: the same reminder sent again next week is the same payload under
   * a new key, and that is correct usage. Which is why this is reported as a
   * rate over enough work to mean something, and never fires on one instance.
   */
  keys: {
    distinctWork: number;
    workSubmittedUnderSeveralKeys: number;
    /**
     * Keys beyond one per piece of work. The strongest single number here,
     * because it is a count of retries the gate could not recognise rather than
     * a ratio that needs a large sample to mean anything.
     */
    excessKeys: number;
    churnRate: number | null;
  };
  /**
   * Does the agent know what an action costs before taking it? A ceiling is only
   * as good as the estimates declared against it, and one that nothing is
   * counted toward can never fire.
   */
  cost: {
    measurable: number;
    declaredNothing: number;
    /** Median of actual / declared. 1 is perfect; below 1 means over-declaring. */
    medianAccuracy: number | null;
    underDeclared: number;
  };
  /**
   * How long the agent sits on a lease before reporting. Compare against the
   * lease length in policy: an agent routinely using most of its window is one
   * slow vendor call away from producing indeterminates.
   */
  lease: { measured: number; medianHoldSeconds: number | null; p95HoldSeconds: number | null };
  /** Plain sentences, worst first. Empty when nothing crosses a threshold. */
  concerns: { code: string; severity: 'high' | 'medium' | 'low'; detail: string }[];
}

export interface AgentSummary {
  agentId: string;
  effects: number;
  /**
   * Effects that actually ended, and therefore the denominator reportRate was
   * computed over. Returned because a UI showing "not enough yet" alongside the
   * effect count would quote a sample that does not exist: effects still in
   * flight have concluded nothing.
   */
  concluded: number;
  reportRate: number | null;
  lastSeen: string;
}

const rate = (n: number, d: number, floor = FLOOR) =>
  d >= floor ? Number((n / d).toFixed(4)) : null;

/**
 * Agents seen in the window, busiest first.
 *
 * `agent_id` is caller-supplied and never trusted for anything but grouping —
 * it selects no policy, grants no permission, and changes no decision.
 */
export async function listAgents(
  db: Db, workspaceId: string, days: number,
): Promise<AgentSummary[]> {
  const { rows } = await db.query<{
    agent_id: string; effects: string; concluded: string; reported: string; last_seen: Date;
  }>(
    `SELECT agent_id,
            count(*)                                              AS effects,
            count(*) FILTER (
              WHERE state IN ('succeeded','failed','indeterminate')) AS concluded,
            count(*) FILTER (WHERE state IN ('succeeded','failed')) AS reported,
            max(created_at)                                       AS last_seen
       FROM effects
      WHERE workspace_id = $1
        AND agent_id IS NOT NULL
        AND created_at > now() - make_interval(days => $2)
      GROUP BY agent_id
      ORDER BY effects DESC, agent_id
      LIMIT 200`,
    [workspaceId, days]);

  return rows.map((r) => ({
    agentId: r.agent_id,
    effects: Number(r.effects),
    concluded: Number(r.concluded),
    reportRate: rate(Number(r.reported), Number(r.concluded)),
    lastSeen: r.last_seen.toISOString(),
  }));
}

export async function agentReliability(
  db: Db, workspaceId: string, agentId: string, days: number,
): Promise<AgentReliability | null> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Outcomes. One pass over the agent's effects in the window.
  const { rows: base } = await db.query<{
    effects: string; concluded: string; reported: string; unreported: string;
    first_seen: Date | null; last_seen: Date | null;
    cost_measurable: string; declared_nothing: string; under_declared: string;
    median_accuracy: string | null;
    lease_measured: string; median_hold: string | null; p95_hold: string | null;
  }>(
    `SELECT count(*)                                                        AS effects,
            count(*) FILTER (WHERE state IN ('succeeded','failed','indeterminate'))
                                                                            AS concluded,
            count(*) FILTER (WHERE state IN ('succeeded','failed'))         AS reported,
            count(*) FILTER (WHERE state = 'indeterminate')                 AS unreported,
            min(created_at)                                                 AS first_seen,
            max(created_at)                                                 AS last_seen,

            -- Cost: only effects that both declared something and settled with a
            -- real figure can be compared. Everything else is counted, not averaged.
            count(*) FILTER (WHERE state = 'succeeded' AND declared_micros > 0)
                                                                            AS cost_measurable,
            count(*) FILTER (WHERE state = 'succeeded' AND declared_micros = 0
                                   AND actual_micros > 0)                   AS declared_nothing,
            count(*) FILTER (WHERE state = 'succeeded' AND declared_micros > 0
                                   AND actual_micros > declared_micros)     AS under_declared,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY actual_micros::numeric / NULLIF(declared_micros, 0)
            ) FILTER (WHERE state = 'succeeded' AND declared_micros > 0)    AS median_accuracy,

            -- Lease hold: how long between taking permission and reporting.
            count(*) FILTER (WHERE lease_granted_at IS NOT NULL AND settled_at IS NOT NULL)
                                                                            AS lease_measured,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (settled_at - lease_granted_at))
            ) FILTER (WHERE lease_granted_at IS NOT NULL AND settled_at IS NOT NULL)
                                                                            AS median_hold,
            percentile_cont(0.95) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (settled_at - lease_granted_at))
            ) FILTER (WHERE lease_granted_at IS NOT NULL AND settled_at IS NOT NULL)
                                                                            AS p95_hold
       FROM effects
      WHERE workspace_id = $1 AND agent_id = $2
        AND created_at > now() - make_interval(days => $3)`,
    [workspaceId, agentId, days]);

  const b = base[0];
  if (!b || Number(b.effects) === 0) return null;   // never seen here — a 404, not a zeroed profile

  // What begin actually answered. Receipts hold every call, including the ones
  // that created no effect row, which is precisely where retry behaviour lives.
  const { rows: dec } = await db.query<{ decision: string; n: string }>(
    `SELECT r.decision, count(*) AS n
       FROM receipts r
       JOIN effects e ON e.id = r.effect_id
      WHERE r.workspace_id = $1 AND e.agent_id = $2
        AND r.created_at > now() - make_interval(days => $3)
      GROUP BY r.decision`,
    [workspaceId, agentId, days]);
  const decisions: Record<string, number> = {};
  for (const d of dec) decisions[d.decision] = Number(d.n);

  // Key hygiene. One unit of work is one (effect_type, payload fingerprint); if
  // it arrived under more than one idempotency key, the agent is generating keys
  // that do not identify the work.
  const { rows: keys } = await db.query<{ work: string; churned: string; excess: string }>(
    `SELECT count(*)                          AS work,
            count(*) FILTER (WHERE keys > 1)  AS churned,
            COALESCE(sum(keys - 1), 0)        AS excess
       FROM (SELECT count(DISTINCT idempotency_key) AS keys
               FROM effects
              WHERE workspace_id = $1 AND agent_id = $2
                AND created_at > now() - make_interval(days => $3)
              GROUP BY effect_type, fingerprint) w`,
    [workspaceId, agentId, days]);

  const concluded = Number(b.concluded);
  const reported = Number(b.reported);
  const unreported = Number(b.unreported);
  const work = Number(keys[0]?.work ?? 0);
  const churned = Number(keys[0]?.churned ?? 0);
  const excessKeys = Number(keys[0]?.excess ?? 0);
  const costMeasurable = Number(b.cost_measurable);
  const leaseMeasured = Number(b.lease_measured);

  const profile: AgentReliability = {
    agentId,
    window: { days, since },
    volume: {
      effects: Number(b.effects),
      firstSeen: b.first_seen ? b.first_seen.toISOString() : null,
      lastSeen: b.last_seen ? b.last_seen.toISOString() : null,
    },
    reporting: { concluded, reported, unreported, reportRate: rate(reported, concluded) },
    decisions,
    keys: {
      distinctWork: work,
      workSubmittedUnderSeveralKeys: churned,
      excessKeys,
      /**
       * The floor belongs on how much was observed, not on how many distinct
       * things were observed. An agent doing six kinds of thing repeatedly is a
       * completely normal shape — and running real traffic through this showed
       * it is also the shape where churn matters most: 24 calls across 6
       * payloads under 24 keys defeats the gate entirely, and gating the rate on
       * "6 work items" made that silent. Two distinct pieces of work are still
       * required, so one deliberately repeated thing cannot trigger it alone.
       */
      churnRate: work >= 2 && Number(b.effects) >= FLOOR
        ? Number((churned / work).toFixed(4)) : null,
    },
    cost: {
      measurable: costMeasurable,
      declaredNothing: Number(b.declared_nothing),
      medianAccuracy: b.median_accuracy !== null && costMeasurable >= SAMPLE_FLOOR
        ? Number(Number(b.median_accuracy).toFixed(3)) : null,
      underDeclared: Number(b.under_declared),
    },
    lease: {
      measured: leaseMeasured,
      medianHoldSeconds: b.median_hold !== null && leaseMeasured >= SAMPLE_FLOOR
        ? Number(Number(b.median_hold).toFixed(2)) : null,
      p95HoldSeconds: b.p95_hold !== null && leaseMeasured >= SAMPLE_FLOOR
        ? Number(Number(b.p95_hold).toFixed(2)) : null,
    },
    concerns: [],
  };

  profile.concerns = concerns(profile);
  return profile;
}

/**
 * Thresholds, in one place, each with the sentence it produces.
 *
 * Every one of these fires only where the underlying metric survived its volume
 * floor, so a quiet workspace produces no concerns rather than false ones. The
 * wording says what to do, not how bad it is: a severity with no remedy attached
 * is a number wearing a costume.
 */
function concerns(p: AgentReliability): AgentReliability['concerns'] {
  const out: AgentReliability['concerns'] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  if (p.reporting.reportRate !== null && p.reporting.reportRate < 0.95) {
    out.push({
      code: 'unreported_outcomes',
      severity: p.reporting.reportRate < 0.8 ? 'high' : 'medium',
      detail:
        `${p.reporting.unreported} of ${p.reporting.concluded} concluded effects were never `
        + `reported (${pct(1 - p.reporting.reportRate)}). Each one is a real-world action whose `
        + 'outcome nobody knows, and the next attempt on that idempotency_key is blocked until '
        + 'someone resolves it. The usual cause is the agent crashing or returning between '
        + 'acting and calling report.',
    });
  }

  if (p.keys.churnRate !== null && p.keys.churnRate > 0.05) {
    out.push({
      code: 'idempotency_key_churn',
      severity: p.keys.churnRate > 0.2 ? 'high' : 'medium',
      detail:
        `${p.keys.workSubmittedUnderSeveralKeys} of ${p.keys.distinctWork} distinct pieces of `
        + `work arrived under more than one idempotency key (${pct(p.keys.churnRate)}), using `
        + `${p.keys.excessKeys} more keys than there was work. A key generated per attempt `
        + 'cannot identify a retry, so the gate sees new work every time and permits it. Derive '
        + 'the key from the work itself. Deliberate repeats look the same from here, so check '
        + 'before acting on this one.',
    });
  }

  const inFlight = p.decisions['in_flight'] ?? 0;
  const total = Object.values(p.decisions).reduce((a, n) => a + n, 0);
  if (total >= FLOOR && inFlight / total > 0.15) {
    out.push({
      code: 'impatient_retries',
      severity: 'low',
      detail:
        `${pct(inFlight / total)} of calls were told in_flight — the agent asked again while it `
        + 'still held a live lease. Honour retry_after_seconds rather than re-asking immediately.',
    });
  }

  if (p.cost.declaredNothing > 0 && p.cost.declaredNothing >= p.cost.measurable) {
    out.push({
      code: 'undeclared_cost',
      severity: 'medium',
      detail:
        `${p.cost.declaredNothing} effects spent money without declaring an estimate first. `
        + 'Spend ceilings are computed from estimated_cost_micros, so a ceiling with nothing '
        + 'counted against it can never fire.',
    });
  }

  if (p.cost.medianAccuracy !== null && p.cost.medianAccuracy > 1.1) {
    out.push({
      code: 'under_declared_cost',
      severity: 'medium',
      detail:
        `Actual spend is typically ${p.cost.medianAccuracy}x what this agent declares. A budget `
        + 'sized against its estimates is smaller than the money it actually moves.',
    });
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, z) => order[a.severity] - order[z.severity]);
}

export const _internals = { FLOOR, SAMPLE_FLOOR, concerns };

/** Convenience for callers that do not hold a pool. */
export const withPool = {
  listAgents: (workspaceId: string, days: number) => listAgents(getPool(), workspaceId, days),
  agentReliability: (workspaceId: string, agentId: string, days: number) =>
    agentReliability(getPool(), workspaceId, agentId, days),
};
