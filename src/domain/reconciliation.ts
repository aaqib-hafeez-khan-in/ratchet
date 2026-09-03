import { getPool, type Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { enqueueEvent } from './events.js';

/**
 * Reconciliation as a habit rather than a reflex.
 *
 * `POST /v1/reconcile` answers the one question a gate cannot answer alone: which
 * real actions never came through it. A leaked key, a colleague's script, the old
 * cron job — all invisible from inside, and all visible the moment you compare
 * the gate's record against the vendor's.
 *
 * The catch is that it only ever ran when somebody already suspected something.
 * Nobody schedules the check they reach for when alarmed, so in practice the
 * control that finds ungated paths ran approximately never, and a control that
 * runs never is indistinguishable from one that does not exist.
 *
 * WHAT IS SCHEDULED IS THE ASKING. Ratchet still cannot fetch anything: it has no
 * vendor credentials and no outbound access to customer systems, and that
 * boundary is the product's main safety property. It has the one thing the
 * customer's own cron does not — it knows how long it has been since the last
 * comparison, per effect type — so it keeps the calendar and says when a check is
 * overdue. The vendor's truth still arrives from the customer, by the same POST.
 */

/** Never nag about a type whose cadence was set moments ago. */
const GRACE_HOURS = 1;

export interface ReconciliationStatus {
  effectType: string;
  everyHours: number | null;
  lastRunAt: string | null;
  /** null when it has never run: "overdue by" has no meaning yet. */
  hoursSinceLastRun: number | null;
  dueAt: string | null;
  overdue: boolean;
  /** Counts from the most recent run, so drift is visible without a second call. */
  lastRun: { checked: number; gated: number; ungated: number } | null;
  /** Ungated totals over the last ten runs, oldest first. A rising line is the point. */
  ungatedTrend: number[];
}

/** Record one comparison. Counts only — see the migration for why. */
export async function recordRun(
  db: Db, workspaceId: string, effectType: string,
  counts: { checked: number; gated: number; ungated: number },
): Promise<void> {
  await db.query(
    `INSERT INTO reconciliation_runs (id, workspace_id, effect_type, checked, gated, ungated)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [newId('rec'), workspaceId, effectType, counts.checked, counts.gated, counts.ungated],
  );
}

/**
 * Where every effect type stands, whether or not a cadence is set.
 *
 * Types with no cadence are included on purpose: "you have never reconciled
 * payment.payout and you have not asked to be reminded" is the answer an operator
 * most needs, and it is exactly the answer a list filtered to configured types
 * would hide.
 */
export async function reconciliationStatus(
  db: Db, workspaceId: string,
): Promise<ReconciliationStatus[]> {
  const { rows } = await db.query<{
    effect_type: string; every_hours: number | null;
    last_run_at: Date | null; hours_since: string | null;
    checked: number | null; gated: number | null; ungated: number | null;
    trend: number[] | null; clock_from: Date;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (effect_type)
              effect_type, created_at, checked, gated, ungated
         FROM reconciliation_runs
        WHERE workspace_id = $1
        ORDER BY effect_type, created_at DESC
     ),
     trend AS (
       SELECT effect_type, array_agg(ungated ORDER BY created_at) AS ungated
         FROM (
           SELECT effect_type, ungated, created_at,
                  row_number() OVER (PARTITION BY effect_type ORDER BY created_at DESC) AS rn
             FROM reconciliation_runs WHERE workspace_id = $1
         ) r
        WHERE rn <= 10
        GROUP BY effect_type
     )
     SELECT p.effect_type,
            p.reconcile_every_hours AS every_hours,
            l.created_at            AS last_run_at,
            EXTRACT(EPOCH FROM (now() - l.created_at)) / 3600 AS hours_since,
            l.checked, l.gated, l.ungated,
            t.ungated               AS trend,
            -- Never reconciled: the clock starts when the policy was last
            -- touched, so setting a cadence does not fire an alert on the
            -- next sweep for history that predates the setting.
            COALESCE(l.created_at, p.updated_at) AS clock_from
       FROM effect_policies p
       LEFT JOIN latest l ON l.effect_type = p.effect_type
       LEFT JOIN trend  t ON t.effect_type = p.effect_type
      WHERE p.workspace_id = $1
      ORDER BY p.effect_type`,
    [workspaceId],
  );

  return rows.map((r) => {
    const every = r.every_hours;
    const clockFrom = r.clock_from;
    const dueAt = every === null ? null
      : new Date(clockFrom.getTime() + every * 3_600_000);
    return {
      effectType: r.effect_type,
      everyHours: every,
      lastRunAt: r.last_run_at?.toISOString() ?? null,
      hoursSinceLastRun: r.hours_since === null
        ? null : Number(Number(r.hours_since).toFixed(2)),
      dueAt: dueAt?.toISOString() ?? null,
      overdue: dueAt !== null && dueAt.getTime() <= Date.now(),
      lastRun: r.checked === null ? null : {
        checked: Number(r.checked), gated: Number(r.gated), ungated: Number(r.ungated),
      },
      ungatedTrend: (r.trend ?? []).map(Number),
    };
  });
}

/**
 * The sweep. Announces effect types whose comparison is overdue.
 *
 * Claimed with FOR UPDATE SKIP LOCKED so several worker replicas cannot announce
 * the same one twice, and stamped with `reconcile_due_notified_at` so the same
 * overdue check is announced once per cadence rather than once per sweep.
 */
export async function noticeOverdue(now = new Date()): Promise<number> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<{
      workspace_id: string; effect_type: string; every_hours: number;
      last_run_at: Date | null; clock_from: Date;
    }>(
      `SELECT p.workspace_id, p.effect_type,
              p.reconcile_every_hours AS every_hours,
              l.created_at AS last_run_at,
              COALESCE(l.created_at, p.updated_at) AS clock_from
         FROM effect_policies p
         JOIN workspaces w ON w.id = p.workspace_id
         LEFT JOIN LATERAL (
           SELECT created_at FROM reconciliation_runs r
            WHERE r.workspace_id = p.workspace_id AND r.effect_type = p.effect_type
            ORDER BY created_at DESC LIMIT 1
         ) l ON true
        WHERE p.reconcile_every_hours IS NOT NULL
          -- Overdue against the last run, or against the moment the cadence was set.
          AND COALESCE(l.created_at, p.updated_at)
              < $1::timestamptz - make_interval(hours => p.reconcile_every_hours)
          -- And past the grace period, so a cadence set a minute ago is not
          -- instantly overdue for an effect type that has run for months.
          AND p.updated_at < $1::timestamptz - make_interval(hours => $2)
          -- Once per cadence, not once per sweep.
          AND (p.reconcile_due_notified_at IS NULL
               OR p.reconcile_due_notified_at
                  < $1::timestamptz - make_interval(hours => p.reconcile_every_hours))
        ORDER BY p.workspace_id, p.effect_type
        FOR UPDATE OF p SKIP LOCKED
        LIMIT 200`,
      [now.toISOString(), GRACE_HOURS],
    );

    for (const r of rows) {
      const hoursSince = (now.getTime() - r.clock_from.getTime()) / 3_600_000;
      await enqueueEvent(tx, r.workspace_id, 'reconciliation.due', {
        // enqueueEvent dedupes on a hash of the payload, which is right for an
        // event that describes one thing happening once. This one describes a
        // state that PERSISTS — still not reconciled — so a second announcement a
        // cadence later is a new occurrence, not a duplicate, and without a
        // distinct field it would be silently swallowed. Two replicas sweeping at
        // the same instant are already prevented from double-announcing by
        // SKIP LOCKED and the notified stamp below, which is where that guarantee
        // belongs.
        noticedAt: now.toISOString(),
        effectType: r.effect_type,
        everyHours: r.every_hours,
        lastRunAt: r.last_run_at?.toISOString() ?? null,
        hoursSinceLastRun: Number(hoursSince.toFixed(1)),
        detail: r.last_run_at === null
          ? `"${r.effect_type}" has never been reconciled. Post the keys your vendor `
            + 'says happened to POST /v1/reconcile; the ones Ratchet has never seen are '
            + 'code paths that acted without asking.'
          : `"${r.effect_type}" was last reconciled ${Math.round(hoursSince)} hours ago, `
            + `against a cadence of every ${r.every_hours}. Ratchet cannot fetch your `
            + 'vendor\'s records — post them and it will say which it never authorised.',
      });
      await tx.query(
        `UPDATE effect_policies SET reconcile_due_notified_at = $3
          WHERE workspace_id = $1 AND effect_type = $2`,
        [r.workspace_id, r.effect_type, now.toISOString()],
      );
    }
    return rows.length;
  });
}

export const withPool = {
  reconciliationStatus: (workspaceId: string) => reconciliationStatus(getPool(), workspaceId),
};

export const _internals = { GRACE_HOURS };
