// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { getPool } from '../db/pool.js';

/**
 * Operating metrics, computed from the durable analytics tables.
 *
 * These are exactly the thresholds named in
 * docs/handoff/PRICING_AND_DISTRIBUTION_REVIEW.md §6. That review could not
 * evaluate any of them because nothing was instrumented; this module is what
 * makes them answerable.
 *
 * They are operating targets, not market facts, and a number computed over
 * five workspaces means nothing — `sampleSize` is reported so a small sample
 * cannot be mistaken for a signal.
 */

export interface Metrics {
  generatedAt: string;
  windowDays: number;
  sampleSize: number;
  workspaces: { total: number; createdInWindow: number };
  activation: {
    /** Reached a first begin. */
    reachedFirstBegin: number;
    /** Completed a full execute → report cycle. This is activation. */
    activated: number;
    activationRate: number | null;
    medianMinutesToFirstSuccess: number | null;
    p90MinutesToFirstSuccess: number | null;
  };
  usage: {
    activeWorkspacesLast7Days: number;
    activeWorkspacesLast30Days: number;
    /** Activated workspaces that were still active in days 7–14 after signup. */
    repeatUsageRate: number | null;
    effectsBegunLast30Days: number;
    effectsSucceededLast30Days: number;
    effectsIndeterminateLast30Days: number;
    indeterminateRate: number | null;
  };
  retention: {
    /** Signed up ≥30 days ago and active in the last 14 days. */
    month1: number | null;
    /** Signed up ≥90 days ago and active in the last 30 days. */
    month3: number | null;
  };
  revenue: {
    paidWorkspaces: number;
    creditOutstandingMicros: number;
    creditPurchasedMicros: number;
    creditReversedMicros: number;
    meteredRevenueMicros: number;
  };
}

const rate = (n: number, d: number): number | null =>
  d === 0 ? null : Number((n / d).toFixed(4));

export async function computeMetrics(windowDays = 30): Promise<Metrics> {
  const db = getPool();

  const [ws, miles, active, counts, money, repeat, ret] = await Promise.all([
    db.query<{ total: string; in_window: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE created_at > now() - ($1 || ' days')::interval) AS in_window
         FROM workspaces`, [String(windowDays)]),

    db.query<{ milestone: string; n: string }>(
      `SELECT milestone, count(*) AS n FROM workspace_milestones GROUP BY milestone`),

    db.query<{ d7: string; d30: string }>(
      `SELECT count(DISTINCT workspace_id) FILTER (WHERE day > (now() AT TIME ZONE 'utc')::date - 7) AS d7,
              count(DISTINCT workspace_id) FILTER (WHERE day > (now() AT TIME ZONE 'utc')::date - 30) AS d30
         FROM workspace_activity`),

    db.query<{ begun: string; succeeded: string; indeterminate: string }>(
      `SELECT COALESCE(sum(effects_begun),0) AS begun,
              COALESCE(sum(effects_succeeded),0) AS succeeded,
              COALESCE(sum(effects_indeterminate),0) AS indeterminate
         FROM workspace_activity
        WHERE day > (now() AT TIME ZONE 'utc')::date - 30`),

    db.query<{ paid: string; outstanding: string; purchased: string; reversed: string; metered: string }>(
      `SELECT (SELECT count(*) FROM workspaces WHERE plan <> 'free') AS paid,
              (SELECT COALESCE(sum(credit_micros),0) FROM workspaces) AS outstanding,
              (SELECT COALESCE(sum(delta_micros),0) FROM ledger_entries WHERE kind = 'topup') AS purchased,
              (SELECT COALESCE(-sum(delta_micros),0) FROM ledger_entries
                WHERE kind = 'adjustment' AND delta_micros < 0) AS reversed,
              (SELECT COALESCE(-sum(delta_micros),0) FROM ledger_entries WHERE kind = 'metering') AS metered`),

    // Activated workspaces still active in days 7–14 after signup.
    db.query<{ eligible: string; repeated: string }>(
      `WITH activated AS (
         SELECT m.workspace_id, w.created_at
           FROM workspace_milestones m
           JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.milestone = 'first_success'
            AND w.created_at < now() - interval '14 days')
       SELECT count(*) AS eligible,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM workspace_activity a
                 WHERE a.workspace_id = activated.workspace_id
                   AND a.day BETWEEN (activated.created_at + interval '7 days')::date
                                 AND (activated.created_at + interval '14 days')::date)) AS repeated
         FROM activated`),

    db.query<{ m1_elig: string; m1_ret: string; m3_elig: string; m3_ret: string }>(
      `SELECT
         count(*) FILTER (WHERE created_at < now() - interval '30 days') AS m1_elig,
         count(*) FILTER (WHERE created_at < now() - interval '30 days' AND EXISTS (
           SELECT 1 FROM workspace_activity a WHERE a.workspace_id = w.id
             AND a.day > (now() AT TIME ZONE 'utc')::date - 14)) AS m1_ret,
         count(*) FILTER (WHERE created_at < now() - interval '90 days') AS m3_elig,
         count(*) FILTER (WHERE created_at < now() - interval '90 days' AND EXISTS (
           SELECT 1 FROM workspace_activity a WHERE a.workspace_id = w.id
             AND a.day > (now() AT TIME ZONE 'utc')::date - 30)) AS m3_ret
       FROM workspaces w`),
  ]);

  // Time to activation, from signup to the first completed workflow.
  const ttf = await db.query<{ p50: string | null; p90: string | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) AS p90
       FROM (SELECT EXTRACT(EPOCH FROM (m.reached_at - w.created_at)) AS secs
               FROM workspace_milestones m
               JOIN workspaces w ON w.id = m.workspace_id
              WHERE m.milestone = 'first_success') t`);

  const mile = (name: string) =>
    Number(miles.rows.find((r) => r.milestone === name)?.n ?? 0);

  const total = Number(ws.rows[0]!.total);
  const activated = mile('first_success');
  const begun = Number(counts.rows[0]!.begun);
  const indet = Number(counts.rows[0]!.indeterminate);
  const mins = (v: string | null) => (v === null ? null : Number((Number(v) / 60).toFixed(1)));

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    sampleSize: total,
    workspaces: { total, createdInWindow: Number(ws.rows[0]!.in_window) },
    activation: {
      reachedFirstBegin: mile('first_begin'),
      activated,
      activationRate: rate(activated, total),
      medianMinutesToFirstSuccess: mins(ttf.rows[0]?.p50 ?? null),
      p90MinutesToFirstSuccess: mins(ttf.rows[0]?.p90 ?? null),
    },
    usage: {
      activeWorkspacesLast7Days: Number(active.rows[0]!.d7),
      activeWorkspacesLast30Days: Number(active.rows[0]!.d30),
      repeatUsageRate: rate(Number(repeat.rows[0]!.repeated), Number(repeat.rows[0]!.eligible)),
      effectsBegunLast30Days: begun,
      effectsSucceededLast30Days: Number(counts.rows[0]!.succeeded),
      effectsIndeterminateLast30Days: indet,
      indeterminateRate: rate(indet, begun),
    },
    retention: {
      month1: rate(Number(ret.rows[0]!.m1_ret), Number(ret.rows[0]!.m1_elig)),
      month3: rate(Number(ret.rows[0]!.m3_ret), Number(ret.rows[0]!.m3_elig)),
    },
    revenue: {
      paidWorkspaces: Number(money.rows[0]!.paid),
      creditOutstandingMicros: Number(money.rows[0]!.outstanding),
      creditPurchasedMicros: Number(money.rows[0]!.purchased),
      creditReversedMicros: Number(money.rows[0]!.reversed),
      meteredRevenueMicros: Number(money.rows[0]!.metered),
    },
  };
}
