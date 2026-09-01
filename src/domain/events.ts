import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { newId, sha256Hex } from '../lib/ids.js';

export const EVENT_TYPES = [
  'effect.succeeded',
  'effect.failed',
  'effect.indeterminate',
  'effect.approval_required',
  'effect.approved',
  'effect.rejected',
  'effect.denied',
  'budget.exceeded',
  'circuit.tripped',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Fan an event out to every subscribed endpoint. The dedupe key is derived
 * from the payload, so enqueuing the same logical event twice (e.g. a retried
 * transaction) can never produce a duplicate delivery.
 */
export async function enqueueEvent(
  tx: PoolClient, workspaceId: string, eventType: EventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
      WHERE workspace_id = $1 AND disabled_at IS NULL AND $2 = ANY(events)`,
    [workspaceId, eventType],
  );
  if (rows.length === 0) return;

  const dedupeKey = sha256Hex(`${eventType}:${JSON.stringify(payload)}`).slice(0, 40);
  const body = JSON.stringify({
    type: eventType,
    createdAt: new Date().toISOString(),
    workspaceId,
    data: payload,
  });

  for (const ep of rows) {
    await tx.query(
      `INSERT INTO webhook_deliveries
         (id, workspace_id, endpoint_id, event_type, payload, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint_id, dedupe_key) DO NOTHING`,
      [newId('whd'), workspaceId, ep.id, eventType, body, dedupeKey],
    );
  }
}

export async function listWebhookEndpoints(db: Db, workspaceId: string) {
  const { rows } = await db.query(
    `SELECT id, url, events, disabled_at, created_at
       FROM webhook_endpoints WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id, url: r.url, events: r.events,
    disabled: r.disabled_at !== null, createdAt: r.created_at.toISOString(),
  }));
}

export async function listDeliveries(db: Db, workspaceId: string, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, endpoint_id, event_type, state, attempts, last_status,
            last_error, created_at, delivered_at
       FROM webhook_deliveries WHERE workspace_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    id: r.id, endpointId: r.endpoint_id, eventType: r.event_type,
    state: r.state, attempts: r.attempts, lastStatus: r.last_status,
    lastError: r.last_error, createdAt: r.created_at.toISOString(),
    deliveredAt: r.delivered_at ? r.delivered_at.toISOString() : null,
  }));
}
