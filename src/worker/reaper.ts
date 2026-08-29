import { withTx, getPool } from '../db/pool.js';
import { enqueueEvent } from '../domain/events.js';
import { adjustSpend } from '../domain/budget.js';

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
export async function sweepExpiredLeases(batchSize = 50): Promise<number> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<{
      id: string; workspace_id: string; effect_type: string; idempotency_key: string;
      attempt: number; reserved_micros: number; leased_by_key_id: string | null;
      agent_id: string | null; run_id: string | null; created_at: Date;
    }>(
      `SELECT id, workspace_id, effect_type, idempotency_key, attempt,
              reserved_micros, leased_by_key_id, agent_id, run_id, created_at
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
        await adjustSpend(tx, {
          workspaceId: r.workspace_id,
          apiKeyId: r.leased_by_key_id ?? 'unknown',
          effectType: r.effect_type,
          deltaMicros: -r.reserved_micros,
          day: r.created_at,
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

/** Console sessions and delivered webhook records past their useful life. */
export async function collectStaleRecords(): Promise<{ sessions: number; deliveries: number }> {
  const pool = getPool();
  const s = await pool.query('DELETE FROM console_sessions WHERE expires_at <= now()');
  const d = await pool.query(
    `DELETE FROM webhook_deliveries
      WHERE state IN ('delivered','dead') AND created_at < now() - interval '30 days'`);
  return { sessions: s.rowCount ?? 0, deliveries: d.rowCount ?? 0 };
}
