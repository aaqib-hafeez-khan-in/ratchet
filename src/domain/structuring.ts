import { getPool, type Db } from '../db/pool.js';
import { listPolicies } from './policy.js';

/**
 * Amounts that cluster just under a line.
 *
 * Twenty-three payments of $9,800 against a $10,000 threshold is the oldest
 * pattern in the book, and it is invisible from almost everywhere: each payment
 * is well-formed, correctly authorised, under every limit, and unremarkable on
 * its own. It is only visible to something that knows what the line is and can
 * see the whole distribution of amounts against it.
 *
 * That is a strange thing to be, and Ratchet is it. Your vendor sees amounts but
 * not your thresholds. Your ledger sees both but after the fact. The gate sees
 * every amount an agent proposed, before it happened, next to the line it was
 * proposed against.
 *
 * HOW IT IS MEASURED. Not by a model. Two adjacent bands of equal width below
 * the threshold are counted and compared:
 *
 *     control band          hug band
 *   [0.80T ......... 0.90T)[0.90T ......... T)
 *
 * Under any ordinary distribution of real amounts, the band nearest the line
 * holds no more than the band before it — real payment sizes do not spike in the
 * last ten per cent before a number the payer is trying to avoid. An excess in
 * the hug band is the signal, and the ratio between them is reported so an
 * operator can see the size of it rather than a score. This is the bunching
 * comparison used to find behaviour at tax kinks; it assumes nothing about the
 * shape of the distribution beyond that it is not already spiking at the line.
 *
 * IT IS A HINT, NOT A VERDICT, and the wording says so. A cap produces legitimate
 * bunching all by itself: told they may refund up to $10,000, people refund
 * $9,999. What separates that from structuring is intent, which is not visible
 * from here and never will be.
 */

/** Below this many effects in the hug band, a ratio is noise. */
const FLOOR = 10;

/** An excess this many times the control band is worth mentioning. */
const REPORT_AT = 3;

/** And this much is worth mentioning loudly. */
const SEVERE_AT = 6;

/** Band edges as fractions of the threshold. */
const HUG_FROM = 0.9;
const CONTROL_FROM = 0.8;

export interface StructuringFinding {
  effectType: string;
  thresholdMicros: number;
  /** Which line was measured against, so an operator knows what to change. */
  thresholdSource: 'structuring_threshold' | 'max_cost';
  /** Effects in the window that declared an amount at all. */
  examined: number;
  justBelow: number;
  control: number;
  /** justBelow / control, with the control floored at 1 so it is always a number. */
  excessRatio: number;
  severity: 'high' | 'medium';
  detail: string;
  /**
   * Where the bunching is concentrated, by blinded counterparty. Bunching spread
   * across many destinations is usually a cap; bunching at one destination is
   * the shape worth looking at.
   */
  concentratedIn: { dimension: string; blinded: string; count: number }[];
}

export interface StructuringReport {
  window: { days: number; since: string };
  /** Effect types that had a threshold to measure against, whether or not they reported. */
  examinedTypes: {
    effectType: string; thresholdMicros: number;
    thresholdSource: 'structuring_threshold' | 'max_cost';
    examined: number; justBelow: number; control: number;
  }[];
  findings: StructuringFinding[];
  /**
   * Effect types with no line to measure against. Reported rather than skipped:
   * an empty result because nothing was configured looks exactly like an empty
   * result because nothing was found, and those are very different answers.
   */
  withoutThreshold: string[];
}

export async function structuringReport(
  db: Db, workspaceId: string, days: number,
): Promise<StructuringReport> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const policies = await listPolicies(db, workspaceId);

  const lines = policies
    .map((p) => ({
      effectType: p.effectType,
      threshold: p.structuringThresholdMicros ?? p.maxCostMicros,
      source: (p.structuringThresholdMicros !== null
        ? 'structuring_threshold' : 'max_cost') as StructuringFinding['thresholdSource'],
    }))
    .filter((l): l is { effectType: string; threshold: number;
                        source: StructuringFinding['thresholdSource'] } =>
      l.threshold !== null && l.threshold > 0);

  const withoutThreshold = policies
    .filter((p) => (p.structuringThresholdMicros ?? p.maxCostMicros) === null)
    .map((p) => p.effectType);

  if (lines.length === 0) {
    return { window: { days, since }, examinedTypes: [], findings: [], withoutThreshold };
  }

  // One pass. The (type, threshold) pairs travel as arrays so a workspace with
  // fifty policies is still a single round trip.
  const { rows } = await db.query<{
    effect_type: string; threshold: string;
    examined: string; hug: string; control: string;
  }>(
    `WITH t(effect_type, threshold) AS (
       SELECT * FROM unnest($2::text[], $3::bigint[])
     )
     SELECT t.effect_type,
            t.threshold::text AS threshold,
            count(e.id) FILTER (WHERE e.declared_micros > 0) AS examined,
            count(e.id) FILTER (
              WHERE e.declared_micros >= t.threshold * $5::numeric
                AND e.declared_micros <  t.threshold)          AS hug,
            count(e.id) FILTER (
              WHERE e.declared_micros >= t.threshold * $6::numeric
                AND e.declared_micros <  t.threshold * $5::numeric)     AS control
       FROM t
       LEFT JOIN effects e
         ON e.workspace_id = $1
        AND e.effect_type = t.effect_type
        AND e.declared_micros > 0
        AND e.created_at > now() - make_interval(days => $4)
      GROUP BY t.effect_type, t.threshold
      ORDER BY t.effect_type`,
    [workspaceId, lines.map((l) => l.effectType), lines.map((l) => l.threshold),
     days, HUG_FROM, CONTROL_FROM],
  );

  const sourceOf = new Map(lines.map((l) => [l.effectType, l.source]));
  const examinedTypes: StructuringReport['examinedTypes'] = rows.map((r) => ({
    effectType: r.effect_type,
    thresholdMicros: Number(r.threshold),
    thresholdSource: sourceOf.get(r.effect_type)!,
    examined: Number(r.examined),
    justBelow: Number(r.hug),
    control: Number(r.control),
  }));

  const findings: StructuringFinding[] = [];
  for (const t of examinedTypes) {
    if (t.justBelow < FLOOR) continue;
    // The control band floored at one: a hug band of forty against a control
    // band of zero is the strongest possible signal, not a division by zero.
    const ratio = Number((t.justBelow / Math.max(t.control, 1)).toFixed(2));
    if (ratio < REPORT_AT) continue;

    findings.push({
      effectType: t.effectType,
      thresholdMicros: t.thresholdMicros,
      thresholdSource: t.thresholdSource,
      examined: t.examined,
      justBelow: t.justBelow,
      control: t.control,
      excessRatio: ratio,
      severity: ratio >= SEVERE_AT ? 'high' : 'medium',
      detail: sentence(t, ratio),
      concentratedIn: await concentration(db, workspaceId, t, days),
    });
  }

  findings.sort((a, b) => b.excessRatio - a.excessRatio);
  return { window: { days, since }, examinedTypes, findings, withoutThreshold };
}

const usd = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function sentence(t: StructuringReport['examinedTypes'][number], ratio: number): string {
  const pct = Math.round((1 - HUG_FROM) * 100);
  return `${t.justBelow} effects declared an amount in the last ${pct}% below `
    + `${usd(t.thresholdMicros)}, against ${t.control} in the ${pct}% before that — `
    + `${ratio}x as many, pressed up against the line. Amounts do not normally `
    + 'crowd the last stretch before a limit. A cap produces this honestly, though: '
    + 'told they may spend up to a number, people spend just under it. What tells the '
    + 'two apart is not visible from here, so this is a place to look rather than a '
    + `finding. The line measured is ${t.thresholdSource === 'max_cost'
      ? 'the max_cost_micros ceiling on this effect type'
      : 'the structuring_threshold_micros you set for this effect type'}.`;
}

/**
 * Where the bunching sits, by blinded dimension.
 *
 * Spread thinly across many counterparties it is probably a cap. Concentrated on
 * one, it is the shape worth a phone call. Ratchet still cannot say who that
 * counterparty is — only that the same one keeps appearing.
 */
async function concentration(
  db: Db, workspaceId: string, t: StructuringReport['examinedTypes'][number], days: number,
): Promise<StructuringFinding['concentratedIn']> {
  const { rows } = await db.query<{ dim: string; blinded: string; n: string }>(
    `SELECT d.key AS dim, d.value #>> '{}' AS blinded, count(*) AS n
       FROM effects e, jsonb_each(e.dimensions) AS d
      WHERE e.workspace_id = $1
        AND e.effect_type = $2
        AND e.created_at > now() - make_interval(days => $3)
        AND e.declared_micros >= $4::numeric * $5::numeric
        AND e.declared_micros <  $4
      GROUP BY d.key, d.value
      HAVING count(*) >= 2
      ORDER BY n DESC
      LIMIT 5`,
    [workspaceId, t.effectType, days, t.thresholdMicros, HUG_FROM],
  );
  return rows.map((r) => ({ dimension: r.dim, blinded: r.blinded, count: Number(r.n) }));
}

export const withPool = {
  structuringReport: (workspaceId: string, days: number) =>
    structuringReport(getPool(), workspaceId, days),
};

export const _internals = { FLOOR, REPORT_AT, SEVERE_AT, HUG_FROM, CONTROL_FROM };
