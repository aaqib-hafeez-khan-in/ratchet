// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { withTx, getPool } from '../db/pool.js';
import { enqueueEvent } from '../domain/events.js';
import { adjustSpend } from '../domain/budget.js';
import { recordActivityTx, recordMilestoneTx } from '../domain/activity.js';

/**
 * The lease reaper. This is the one piece of the system that genuinely needs a
 * long-running process: a lease that expires with no report must become
 * `indeterminate` even if the agent that held it never comes back.
 *
 * Correctness notes:
 *  - Rows are claimed with SKIP LOCKED, so several worker replicas can run
 *    concurrently without processing the same effect twice.
 *  - The transition is guarded on state='pending', so a report that lands in
 *    the same instant wins the row lock and the reaper simply finds nothing.
 *  - The outstanding external-spend reservation is released, because an
 *    indeterminate effect is no longer holding budget for future work.
 */
/**
 * Drain expired leases until there are none left, in bounded batches.
 *
 * `sweepExpiredLeases` handles one batch and is the right primitive: each batch
 * is its own transaction, so locks are held briefly and replicas interleave
 * cleanly via SKIP LOCKED. But calling it once per tick capped the transition
 * at one batch per interval — 25 leases/second at the default 50 per 2s — while
 * the same loop measured at over 1,300/second when allowed to run. A fleet of
 * agents that dies at once produces exactly that burst, and every effect in the
 * backlog stays `pending` until its turn, so a caller retrying is told
 * `in_flight` and waits instead of learning the outcome is unknown.
 *
 * Safety never depended on the sweep being fast — a lease that has not been
 * swept yet is still expired, and nothing hands out a second `execute`. This is
 * about how long the truth takes to become visible.
 *
 * Bounded by both batches and wall clock so one tick cannot monopolise the
 * worker or starve the webhook loop beside it.
 */
export async function drainExpiredLeases(
  { batchSize = 50, maxBatches = 40, maxMs = 5_000 } = {},
): Promise<number> {
  const deadline = Date.now() + maxMs;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await sweepExpiredLeases(batchSize);
    total += n;
    if (n < batchSize || Date.now() >= deadline) break;
  }
  return total;
}

export async function sweepExpiredLeases(batchSize = 50): Promise<number> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<{
      id: string; workspace_id: string; effect_type: string; idempotency_key: string;
      attempt: number; reserved_micros: number; leased_by_key_id: string | null;
      agent_id: string | null; run_id: string | null; created_at: Date;
      reserved_dimension_scopes: string[];
    }>(
      `SELECT id, workspace_id, effect_type, idempotency_key, attempt,
              reserved_micros, leased_by_key_id, agent_id, run_id, created_at,
              reserved_dimension_scopes
         FROM effects
        WHERE state = 'pending' AND lease_expires_at <= now()
        ORDER BY lease_expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (rows.length === 0) return 0;

    for (const r of rows) {
      await tx.query(
        `UPDATE effects
            SET state = 'indeterminate', lease_token = NULL, lease_expires_at = NULL,
                reserved_micros = 0,
                failure_reason = 'Lease expired before an outcome was reported.',
                updated_at = now()
          WHERE id = $1 AND state = 'pending'`,
        [r.id],
      );
      if (r.reserved_micros > 0) {
        // The reservation comes back, including from any dimension bucket it was
        // taken from. The COUNT stays: an effect that expired unreported was an
        // attempt to act on that counterparty, and the day's velocity allowance
        // was genuinely spent on it. Returning it here would make crashing the
        // agent the cheapest way past a velocity ceiling.
        await adjustSpend(tx, {
          workspaceId: r.workspace_id,
          apiKeyId: r.leased_by_key_id ?? 'unknown',
          effectType: r.effect_type,
          deltaMicros: -r.reserved_micros,
          day: r.created_at,
          dimensionScopes: r.reserved_dimension_scopes ?? [],
        });
      }
      await tx.query(
        `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
         VALUES ($1,'effect.lease_expired','system',$2,$3)`,
        [r.workspace_id, r.id, JSON.stringify({ attempt: r.attempt, effectType: r.effect_type })],
      );
      await enqueueEvent(tx, r.workspace_id, 'effect.indeterminate', {
        effectId: r.id, effectType: r.effect_type, idempotencyKey: r.idempotency_key,
        attempt: r.attempt, agentId: r.agent_id, runId: r.run_id,
      });
      await recordActivityTx(tx, r.workspace_id, 'effects_indeterminate');
      await recordMilestoneTx(tx, r.workspace_id, 'first_indeterminate',
        { effectType: r.effect_type });
    }
    return rows.length;
  });
}

/**
 * Retention. Effect records are removed once past their policy retention
 * window; `pending` rows are never collected, so a live lease cannot vanish.
 */
export async function collectExpiredEffects(batchSize = 500): Promise<number> {
  const res = await getPool().query(
    `DELETE FROM effects
      WHERE id IN (
        SELECT id FROM effects
         WHERE state <> 'pending' AND expires_at <= now()
         LIMIT $1)`,
    [batchSize],
  );
  return res.rowCount ?? 0;
}

/** Console sessions, delivered webhooks, and spent OAuth records past their use. */
export async function collectStaleRecords(): Promise<
  { sessions: number; deliveries: number; oauth: number; anonymous: number;
    orphanReceipts: number; rateLimitWindows: number; surgeWindows: number }> {
  const pool = getPool();
  const s = await pool.query('DELETE FROM console_sessions WHERE expires_at <= now()');
  const d = await pool.query(
    `DELETE FROM webhook_deliveries
      WHERE state IN ('delivered','dead') AND created_at < now() - interval '30 days'`);

  // Authorization codes are single-use and live sixty seconds; keeping spent
  // ones for a day leaves room to investigate a replay before they go.
  const c = await pool.query(
    `DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);
  const t = await pool.query(
    `DELETE FROM oauth_tokens
      WHERE expires_at < now() - interval '30 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`);

  // Registration is unauthenticated, so anyone can create a client row. One
  // that no human ever approved is inert and, after a day, junk. Anything with
  // a token behind it is a real grant and is never swept.
  const cl = await pool.query(
    `DELETE FROM oauth_clients
      WHERE created_at < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = oauth_clients.id)
        AND NOT EXISTS (SELECT 1 FROM oauth_codes  WHERE client_id = oauth_clients.id)`);

  // Anonymously provisioned workspaces that nobody claimed and nobody used.
  // A workspace with effects in it is somebody's trial in progress and is left
  // alone until it is genuinely stale.
  const anon = await pool.query(
    `DELETE FROM workspaces w
      WHERE w.anonymous AND w.claimed_at IS NULL
        AND w.created_at < now() - interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM effects e
           WHERE e.workspace_id = w.id AND e.created_at > now() - interval '7 days')`);

  // Surge counters older than the longest window anyone can measure against.
  // Kept for 30 days because currentRates reports a 30-day peak, which is what
  // an operator uses to choose a threshold.
  const erw = await pool.query(
    `DELETE FROM effect_rate_windows WHERE hour_start < now() - interval '31 days'`);

  // Breakers belonging to workspaces that no longer exist. Like receipts, this
  // table has no foreign key — see migration 022 for why.
  const orphanCircuits = await pool.query(
    `DELETE FROM circuit_breakers c
      WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = c.workspace_id)`);
  const orphanRates = await pool.query(
    `DELETE FROM effect_rate_windows r
      WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = r.workspace_id)`);

  // Rate-limit windows are only interesting while they are open. Keeping one
  // extra window is enough for an instance that is a flush behind; beyond that
  // the row can never be read again.
  const rl = await pool.query(
    `DELETE FROM rate_limit_counters WHERE window_start < now() - interval '10 minutes'`);

  // Receipts deliberately have no foreign key to workspaces — it deadlocked the
  // decision path — so deleting a workspace's audit trail happens here instead.
  const orphans = await pool.query(
    `DELETE FROM receipts r
      WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = r.workspace_id)`);

  return { orphanReceipts: orphans.rowCount ?? 0,
           rateLimitWindows: rl.rowCount ?? 0,
           surgeWindows: (erw.rowCount ?? 0) + (orphanRates.rowCount ?? 0)
                       + (orphanCircuits.rowCount ?? 0),
           sessions: s.rowCount ?? 0, deliveries: d.rowCount ?? 0,
           oauth: (c.rowCount ?? 0) + (t.rowCount ?? 0) + (cl.rowCount ?? 0),
           anonymous: anon.rowCount ?? 0 };
}
