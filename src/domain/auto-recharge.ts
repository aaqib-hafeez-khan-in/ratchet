// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { randomUUID } from 'node:crypto';
import { getPool, type Db } from '../db/pool.js';
import { CREDIT_PACKS, packById, type CreditPack } from './billing.js';
import { errors } from '../lib/errors.js';

/**
 * Keep a customer's prepaid balance topped up, without a human present.
 *
 * Overage draws on prepaid credit and a zero balance REFUSES the effect. That
 * is the right default — nothing is billed by surprise — but it means somebody
 * using the product successfully hits a wall at 3am. This is the opt-in for
 * "don't let that happen".
 *
 * WHY THIS FILE IS SO CAUTIOUS. It charges a real card with nobody watching. A
 * bug does not lose data; it takes money repeatedly from somebody who trusted
 * us, inside a product whose entire argument is that the same action must
 * happen at most once. There is no version of that which is survivable, so
 * every guard below is deliberate:
 *
 *   1. OFF unless explicitly enabled. There is no default that charges anyone.
 *   2. A card must already be on file. We never ask for one here.
 *   3. At most once per shortfall, enforced by a unique index — the same way
 *      the product enforces its own guarantee, and for the same reason: an
 *      application-level check is one refactor from being wrong.
 *   4. The Stripe call carries the row id as its idempotency key, so a retried
 *      HTTP request cannot become a second charge.
 *   5. A hard daily cap. A runaway spend loop must drain an allowance, not a
 *      bank account. This is surge containment pointed at ourselves.
 *   6. A declined card DISABLES it and says why. Retrying a decline is how a
 *      card gets locked and a customer gets a fraud alert about us.
 *   7. It never runs inside the gate's transaction. A network call holding a
 *      row lock would slow every begin, and a transaction that rolls back
 *      after a successful charge would take money for credit never granted.
 */

/** Never more than this many automatic charges a day, whatever the settings say. */
export const MAX_RECHARGES_PER_DAY = 3;

export interface AutoRechargeSettings {
  enabled: boolean;
  thresholdMicros: number | null;
  packId: string | null;
  disabledReason: string | null;
}

export interface RechargeRow {
  id: string;
  workspaceId: string;
  packId: string;
  amountMicros: number;
  state: 'pending' | 'succeeded' | 'failed';
  failureReason: string | null;
  createdAt: string;
}

export function readSettings(row: {
  auto_recharge_enabled: boolean;
  auto_recharge_threshold_micros: string | number | null;
  auto_recharge_pack_id: string | null;
  auto_recharge_disabled_reason: string | null;
}): AutoRechargeSettings {
  return {
    enabled: row.auto_recharge_enabled,
    thresholdMicros: row.auto_recharge_threshold_micros === null
      ? null : Number(row.auto_recharge_threshold_micros),
    packId: row.auto_recharge_pack_id,
    disabledReason: row.auto_recharge_disabled_reason,
  };
}

/**
 * Turn it on or off.
 *
 * Enabling requires a card already on file. Asking for one here would mean
 * collecting payment details on a settings screen, and this service does not
 * take card details anywhere — they are entered on Stripe's own page or not
 * at all.
 */
export async function configure(
  workspaceId: string,
  input: { enabled: boolean; thresholdMicros?: number; packId?: string },
  db: Db = getPool(),
): Promise<AutoRechargeSettings> {
  if (!input.enabled) {
    const { rows } = await db.query(
      `UPDATE workspaces
          SET auto_recharge_enabled = false, auto_recharge_disabled_reason = NULL
        WHERE id = $1
      RETURNING auto_recharge_enabled, auto_recharge_threshold_micros,
                auto_recharge_pack_id, auto_recharge_disabled_reason`, [workspaceId]);
    if (!rows[0]) throw errors.notFound('workspace');
    return readSettings(rows[0] as never);
  }

  const pack = input.packId ? packById(input.packId) : undefined;
  if (!pack) {
    throw errors.invalid(
      `pack_id must be one of: ${CREDIT_PACKS.map((p) => p.id).join(', ')}.`);
  }
  const threshold = input.thresholdMicros;
  if (!Number.isInteger(threshold) || (threshold as number) <= 0) {
    throw errors.invalid('threshold_micros must be a positive integer.');
  }
  // A threshold at or above the pack size would top up, immediately be under
  // the threshold again, and top up again — until the daily cap stopped it.
  // Refusing here is kinder than discovering it from a bank statement.
  if ((threshold as number) >= pack.creditMicros) {
    throw errors.invalid(
      'threshold_micros must be below the pack size, or every recharge would '
      + 'immediately leave the balance under the threshold again.');
  }

  const { rows } = await db.query(
    `UPDATE workspaces
        SET auto_recharge_enabled = true,
            auto_recharge_threshold_micros = $2,
            auto_recharge_pack_id = $3,
            auto_recharge_disabled_reason = NULL
      WHERE id = $1 AND stripe_customer_id IS NOT NULL
    RETURNING auto_recharge_enabled, auto_recharge_threshold_micros,
              auto_recharge_pack_id, auto_recharge_disabled_reason`,
    [workspaceId, threshold, pack.id]);

  if (!rows[0]) {
    // Either the workspace is gone or it has no card. Both are refusals; only
    // the second is worth explaining, and it is by far the likelier.
    throw errors.invalid(
      'Automatic top-up needs a card already on file. Subscribe to a paid plan '
      + 'or make one credit purchase first — we never collect card details here.');
  }
  return readSettings(rows[0] as never);
}

/**
 * Claim the right to charge once for the current shortfall.
 *
 * Returns the row to act on, or null when there is nothing to do. Everything
 * that decides "should we" happens inside one statement against the database,
 * because two workers polling at the same instant is the normal case, not the
 * exotic one.
 */
export async function claimRecharge(
  workspaceId: string, db: Db = getPool(),
): Promise<{ row: RechargeRow; pack: CreditPack; customerId: string } | null> {
  const client = await (db as never as { connect(): Promise<never> }).connect?.()
    ?? null;
  const tx = (client ?? db) as Db & { query: Db['query'] };
  const owned = client !== null;

  try {
    if (owned) await tx.query('BEGIN');

    // Lock the workspace so two pollers cannot both read the same balance and
    // both decide to charge. Same lock order as everywhere else: workspaces
    // first.
    const { rows: wsRows } = await tx.query<{
      credit_micros: string; stripe_customer_id: string | null;
      auto_recharge_enabled: boolean; auto_recharge_threshold_micros: string | null;
      auto_recharge_pack_id: string | null;
    }>(
      `SELECT credit_micros, stripe_customer_id, auto_recharge_enabled,
              auto_recharge_threshold_micros, auto_recharge_pack_id
         FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId]);
    const ws = wsRows[0];
    if (!ws || !ws.auto_recharge_enabled || !ws.stripe_customer_id) return null;

    const threshold = Number(ws.auto_recharge_threshold_micros ?? 0);
    if (threshold <= 0 || Number(ws.credit_micros) >= threshold) return null;

    const pack = ws.auto_recharge_pack_id ? packById(ws.auto_recharge_pack_id) : undefined;
    if (!pack) return null;

    // Nothing in flight, and inside the daily cap. Both read under the same
    // lock as the decision they inform.
    const { rows: counts } = await tx.query<{ pending: string; today: string; total: string }>(
      `SELECT count(*) FILTER (WHERE state = 'pending')                       AS pending,
              count(*) FILTER (WHERE created_at > now() - interval '1 day')   AS today,
              count(*)                                                        AS total
         FROM credit_recharges WHERE workspace_id = $1`, [workspaceId]);
    const c = counts[0]!;
    if (Number(c.pending) > 0) return null;
    if (Number(c.today) >= MAX_RECHARGES_PER_DAY) return null;

    // The at-most-once key. Two pollers racing derive the same sequence number
    // and the unique index refuses the second — the guarantee lives there, not
    // in the check above.
    const triggerKey = `seq:${c.total}`;
    const id = `rch_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    const { rows: made } = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO credit_recharges (id, workspace_id, trigger_key, pack_id, amount_micros)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id, trigger_key) DO NOTHING
       RETURNING id, created_at`,
      [id, workspaceId, triggerKey, pack.id, pack.priceMicros]);
    if (!made[0]) return null;   // somebody else won the race, and that is fine

    if (owned) await tx.query('COMMIT');
    return {
      row: {
        id: made[0].id, workspaceId, packId: pack.id, amountMicros: pack.priceMicros,
        state: 'pending', failureReason: null, createdAt: made[0].created_at.toISOString(),
      },
      pack,
      customerId: ws.stripe_customer_id,
    };
  } catch (err) {
    if (owned) await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (owned) (client as unknown as { release(): void }).release();
  }
}

/** Record how a claimed charge turned out. Credit is granted by the webhook, not here. */
export async function settle(
  id: string,
  outcome: { ok: true; paymentIntentId: string } | { ok: false; reason: string },
  db: Db = getPool(),
): Promise<void> {
  if (outcome.ok) {
    await db.query(
      `UPDATE credit_recharges
          SET state = 'succeeded', payment_intent_id = $2, settled_at = now()
        WHERE id = $1 AND state = 'pending'`, [id, outcome.paymentIntentId]);
    return;
  }
  await db.query(
    `UPDATE credit_recharges
        SET state = 'failed', failure_reason = $2, settled_at = now()
      WHERE id = $1 AND state = 'pending'`, [id, outcome.reason.slice(0, 300)]);
}

/**
 * Stop trying, and say why.
 *
 * A declined card is not a transient error. Retrying it is how a card ends up
 * locked and a customer gets a fraud alert with our name on it, so a failure
 * switches the feature off and leaves an explanation where the operator will
 * see it rather than wondering why top-ups stopped.
 */
export async function disable(
  workspaceId: string, reason: string, db: Db = getPool(),
): Promise<void> {
  await db.query(
    `UPDATE workspaces
        SET auto_recharge_enabled = false, auto_recharge_disabled_reason = $2
      WHERE id = $1`, [workspaceId, reason.slice(0, 300)]);
}

/** Workspaces that are enabled and currently below their threshold. */
export async function candidates(db: Db = getPool(), limit = 50): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM workspaces
      WHERE auto_recharge_enabled = true
        AND stripe_customer_id IS NOT NULL
        AND auto_recharge_threshold_micros IS NOT NULL
        AND credit_micros < auto_recharge_threshold_micros
      ORDER BY credit_micros ASC
      LIMIT $1`, [limit]);
  return rows.map((r) => r.id);
}

export async function history(
  workspaceId: string, db: Db = getPool(), limit = 20,
): Promise<RechargeRow[]> {
  const { rows } = await db.query<{
    id: string; pack_id: string; amount_micros: string; state: RechargeRow['state'];
    failure_reason: string | null; created_at: Date;
  }>(
    `SELECT id, pack_id, amount_micros, state, failure_reason, created_at
       FROM credit_recharges WHERE workspace_id = $1
      ORDER BY created_at DESC LIMIT $2`, [workspaceId, limit]);
  return rows.map((r) => ({
    id: r.id, workspaceId, packId: r.pack_id, amountMicros: Number(r.amount_micros),
    state: r.state, failureReason: r.failure_reason, createdAt: r.created_at.toISOString(),
  }));
}
