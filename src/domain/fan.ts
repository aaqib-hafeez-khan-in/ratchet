// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { getPool, type Db } from '../db/pool.js';

/**
 * Fan-out and fan-in: how work spreads across destinations, and how destinations
 * collect work.
 *
 * FAN-OUT is one job touching many counterparties. On its own that is not a
 * signal and treating it as one would be useless — a payroll run pays five
 * hundred people every month and is the healthiest thing in the system. What
 * separates that from a disbursement into a mule network is not how many, it is
 * HOW MANY OF THEM ARE NEW. Payroll pays the same people; a laundering fan-out
 * pays accounts nobody has ever paid. So novelty is the measure, and cardinality
 * is only the floor beneath it.
 *
 * FAN-IN is the opposite: one counterparty collecting from many separate agents
 * or runs. A refund bot and a payout bot both paying the same account is a
 * question worth asking, because each of them individually looks fine and no
 * per-agent limit can see across them.
 *
 * Both are cardinality over the blinded dimension, so both work without Ratchet
 * ever learning a destination. It can count how many distinct ones there are,
 * and whether it has seen them before, without being able to name a single one.
 *
 * NEITHER IS A VERDICT. A first payroll run is one hundred per cent new
 * counterparties and looks exactly like the thing this is meant to catch. There
 * is no way to tell those apart from here, and the wording never pretends
 * otherwise.
 */

/** A group must touch at least this many distinct counterparties to be considered. */
const FANOUT_FLOOR = 20;

/** And this much of it must be new before it is worth mentioning. */
const NEW_SHARE_AT = 0.8;

/** Distinct agents converging on one counterparty before that is worth mentioning. */
const FANIN_FLOOR = 3;

/**
 * How far back "new" looks.
 *
 * Bounded on purpose. "Never seen before" over all history means scanning all
 * history, which gets slower every day the service runs — and a counterparty
 * last paid three years ago is, for this question, new anyway. Four windows is
 * enough context to recognise a monthly rhythm.
 */
const PRIOR_WINDOWS = 4;

export type FanGrouping = 'run' | 'agent';

export interface FanOutFinding {
  grouping: FanGrouping;
  /** The run id or agent id. Caller-supplied, used for grouping and nothing else. */
  id: string;
  distinctCounterparties: number;
  firstSeen: number;
  newShare: number;
  effects: number;
  severity: 'high' | 'medium';
  detail: string;
}

export interface FanInFinding {
  /** Blinded. Ratchet cannot say which counterparty this is. */
  blinded: string;
  distinctAgents: number;
  distinctRuns: number;
  effects: number;
  severity: 'high' | 'medium';
  detail: string;
}

export interface FanReport {
  window: { days: number; since: string };
  dimension: string;
  /** Distinct counterparties seen at all in the window, for context. */
  counterpartiesInWindow: number;
  fanOut: FanOutFinding[];
  fanIn: FanInFinding[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export async function fanReport(
  db: Db, workspaceId: string, dimension: string, days: number,
): Promise<FanReport> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { rows: totals } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT d.value #>> '{}') AS n
       FROM effects e, jsonb_each(e.dimensions) AS d
      WHERE e.workspace_id = $1 AND d.key = $2
        AND e.created_at > now() - make_interval(days => $3)`,
    [workspaceId, dimension, days]);

  const fanOut = [
    ...await fanOutBy(db, workspaceId, dimension, days, 'run'),
    ...await fanOutBy(db, workspaceId, dimension, days, 'agent'),
  ].sort((a, b) => b.firstSeen - a.firstSeen);

  return {
    window: { days, since },
    dimension,
    counterpartiesInWindow: Number(totals[0]?.n ?? 0),
    fanOut,
    fanIn: await fanIn(db, workspaceId, dimension, days),
  };
}

/**
 * One group's spread, and how much of it is new.
 *
 * `grouping` selects a column name from a fixed pair — it is never interpolated
 * from anything a caller sent.
 */
async function fanOutBy(
  db: Db, workspaceId: string, dimension: string, days: number, grouping: FanGrouping,
): Promise<FanOutFinding[]> {
  const column = grouping === 'run' ? 'run_id' : 'agent_id';

  const { rows } = await db.query<{
    id: string; distinct_cp: string; first_seen: string; effects: string;
  }>(
    `WITH win AS (
       SELECT e.${column} AS id, d.value #>> '{}' AS cp, e.id AS effect_id
         FROM effects e, jsonb_each(e.dimensions) AS d
        WHERE e.workspace_id = $1 AND d.key = $2
          AND e.${column} IS NOT NULL
          AND e.created_at > now() - make_interval(days => $3)
     ),
     prior AS (
       SELECT DISTINCT d.value #>> '{}' AS cp
         FROM effects e, jsonb_each(e.dimensions) AS d
        WHERE e.workspace_id = $1 AND d.key = $2
          AND e.created_at <= now() - make_interval(days => $3)
          AND e.created_at >  now() - make_interval(days => $4)
     ),
     pairs AS (SELECT DISTINCT id, cp FROM win)
     SELECT p.id,
            count(*)                                   AS distinct_cp,
            count(*) FILTER (WHERE pr.cp IS NULL)      AS first_seen,
            (SELECT count(*) FROM win w WHERE w.id = p.id) AS effects
       FROM pairs p
       LEFT JOIN prior pr ON pr.cp = p.cp
      GROUP BY p.id
     HAVING count(*) >= $5
      ORDER BY count(*) FILTER (WHERE pr.cp IS NULL) DESC
      LIMIT 20`,
    [workspaceId, dimension, days, days * PRIOR_WINDOWS, FANOUT_FLOOR]);

  const out: FanOutFinding[] = [];
  for (const r of rows) {
    const distinct = Number(r.distinct_cp);
    const first = Number(r.first_seen);
    const share = distinct === 0 ? 0 : first / distinct;
    if (share < NEW_SHARE_AT) continue;      // a run that pays the same people is payroll

    out.push({
      grouping, id: r.id,
      distinctCounterparties: distinct,
      firstSeen: first,
      newShare: Number(share.toFixed(3)),
      effects: Number(r.effects),
      // Both halves matter. A large count that is only mostly new is a growing
      // business; a total absence of anything familiar is the shape worth waking
      // up for, and only once there is enough of it to mean something.
      severity: share >= 0.95 && first >= FANOUT_FLOOR * 2 ? 'high' : 'medium',
      detail:
        `This ${grouping} reached ${distinct} distinct ${dimension} values, and `
        + `${first} of them (${pct(share)}) had not been seen in the preceding `
        + `${days * PRIOR_WINDOWS} days. Spreading widely is not itself a problem — payroll `
        + 'does it every month — but paying almost entirely NEW destinations is the shape a '
        + 'disbursement into fresh accounts makes. A first run of anything looks the same, so '
        + 'this is a question rather than an answer.',
    });
  }
  return out;
}

/** One counterparty, several separate agents. No per-agent limit can see this. */
async function fanIn(
  db: Db, workspaceId: string, dimension: string, days: number,
): Promise<FanInFinding[]> {
  const { rows } = await db.query<{
    cp: string; agents: string; runs: string; effects: string;
  }>(
    `SELECT d.value #>> '{}'                    AS cp,
            count(DISTINCT e.agent_id)          AS agents,
            count(DISTINCT e.run_id)            AS runs,
            count(*)                            AS effects
       FROM effects e, jsonb_each(e.dimensions) AS d
      WHERE e.workspace_id = $1 AND d.key = $2
        AND e.agent_id IS NOT NULL
        AND e.created_at > now() - make_interval(days => $3)
      GROUP BY d.value
     HAVING count(DISTINCT e.agent_id) >= $4
      ORDER BY count(DISTINCT e.agent_id) DESC, count(*) DESC
      LIMIT 20`,
    [workspaceId, dimension, days, FANIN_FLOOR]);

  return rows.map((r) => {
    const agents = Number(r.agents);
    return {
      blinded: r.cp,
      distinctAgents: agents,
      distinctRuns: Number(r.runs),
      effects: Number(r.effects),
      severity: agents >= FANIN_FLOOR * 2 ? 'high' : 'medium',
      detail:
        `${agents} separate agents sent ${r.effects} effects to this one ${dimension}. Each `
        + 'agent on its own is inside every limit it has, because no per-agent ceiling can see '
        + 'across agents. Whether that is a shared supplier or a single account being fed from '
        + 'several directions is not visible from here.',
    };
  });
}

export const withPool = {
  fanReport: (workspaceId: string, dimension: string, days: number) =>
    fanReport(getPool(), workspaceId, dimension, days),
};

export const _internals = { FANOUT_FLOOR, NEW_SHARE_AT, FANIN_FLOOR, PRIOR_WINDOWS };
