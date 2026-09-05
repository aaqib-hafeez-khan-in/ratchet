// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { ANONYMOUS_EFFECT_QUOTA } from './auth.js';
import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { planFor, type Plan } from './plans.js';

export class InsufficientCredit extends Error {
  constructor(
    readonly needMicros: number,
    readonly balanceMicros: number,
    readonly plan: string,
  ) {
    super('Insufficient credit');
    this.name = 'InsufficientCredit';
  }
}

export interface WorkspaceBilling {
  id: string;
  plan: Plan;
  creditMicros: number;
  periodStart: Date;
  periodDecisions: number;
  status: 'active' | 'suspended';
}

interface WsRow {
  id: string; plan: string; credit_micros: number;
  period_start: Date; period_decisions: number; status: 'active' | 'suspended';
  anonymous: boolean;
  email_verified_at: Date | null;
}

/**
 * An unclaimed workspace has spent its trial. There is nobody to bill and
 * nobody to warn, so refusing is the only honest end to it.
 */
export class AnonymousQuotaExhausted extends Error {
  /**
   * `claimed` separates two states that hit the same ceiling and need opposite
   * instructions. Telling somebody who has already given us their address to go
   * and give us their address is the kind of error message that makes people
   * think the product is broken rather than that they have one click left.
   */
  constructor(readonly quota: number, readonly claimed = false) {
    super('Workspace quota exhausted');
    this.name = 'AnonymousQuotaExhausted';
  }
}

export async function getBilling(db: Db, workspaceId: string): Promise<WorkspaceBilling | null> {
  const { rows } = await db.query<WsRow>(
    `SELECT id, plan, credit_micros, period_start, period_decisions, status, anonymous, email_verified_at
       FROM workspaces WHERE id = $1`, [workspaceId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, plan: planFor(r.plan), creditMicros: r.credit_micros,
    periodStart: r.period_start, periodDecisions: r.period_decisions, status: r.status,
  };
}

export interface MeterResult {
  metered: boolean;
  chargedMicros: number;
  decisionsUsed: number;
  decisionsRemaining: number | null;
  balanceMicros: number;
}

/**
 * Charge one gated effect. Called exactly once per newly created effect, as
 * the LAST write of the begin() transaction so the workspace row lock is held
 * for the shortest possible time.
 *
 * Within the monthly allowance this is a counter increment and costs nothing.
 * Beyond it, prepaid credit is drawn and an immutable ledger row is written,
 * keyed on the effect id so a replayed transaction can never double-charge.
 */
export async function meterEffect(
  tx: PoolClient, workspaceId: string, effectId: string, now: Date,
): Promise<MeterResult> {
  const { rows } = await tx.query<WsRow>(
    `SELECT id, plan, credit_micros, period_start, period_decisions, status, anonymous, email_verified_at
       FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId],
  );
  const ws = rows[0];
  if (!ws) throw new Error(`workspace ${workspaceId} disappeared mid-transaction`);

  const plan = planFor(ws.plan);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Roll the billing period forward if we have crossed a month boundary.
  let used = ws.period_decisions;
  let periodRolled = false;
  if (ws.period_start.getTime() < monthStart.getTime()) {
    used = 0;
    periodRolled = true;
  }

  // An unclaimed workspace is capped far below the free plan. It exists to
  // prove the gate works on the first call without a human; running on one is
  // not the offer. Claiming it with an email lifts the cap to the free plan.
  // The plan's allowance belongs to a workspace whose address has answered.
  //
  // Claiming used to be enough, and claiming only wrote an email nobody checked
  // — so a farm of unreachable addresses collected a free plan each. An
  // unverified workspace sits at the unclaimed cap: it works, it gates, it is
  // simply not the free plan yet. Everything that existed before this shipped
  // was grandfathered in the migration, because a control that silently demotes
  // current customers is an outage with a rationale.
  const onPlan = !ws.anonymous && ws.email_verified_at != null;
  const allowance = onPlan
    ? plan.includedEffects
    : Math.min(ANONYMOUS_EFFECT_QUOTA, plan.includedEffects);
  const withinAllowance = used < allowance;
  let charged = 0;
  let balance = ws.credit_micros;

  if (!withinAllowance && !onPlan) {
    // No overage path for an unclaimed workspace: there is nobody to bill and
    // nobody to warn. Refusing here is the honest end of a free trial.
    throw new AnonymousQuotaExhausted(ANONYMOUS_EFFECT_QUOTA, !ws.anonymous);
  }

  if (!withinAllowance) {
    charged = plan.overageMicrosPerEffect;
    if (balance < charged) {
      throw new InsufficientCredit(charged, balance, plan.id);
    }
    balance -= charged;
  }

  await tx.query(
    `UPDATE workspaces
        SET period_decisions = $2,
            period_start     = $3,
            credit_micros    = $4,
            updated_at       = now()
      WHERE id = $1`,
    [workspaceId, used + 1, periodRolled ? monthStart : ws.period_start, balance],
  );

  if (charged > 0) {
    await tx.query(
      `INSERT INTO ledger_entries
         (workspace_id, kind, delta_micros, balance_after, effect_id, dedupe_key, detail)
       VALUES ($1,'metering',$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
      [workspaceId, -charged, balance, effectId, `metering:${effectId}`,
       JSON.stringify({ plan: plan.id, unit: 'gated_effect' })],
    );
  }

  return {
    metered: true,
    chargedMicros: charged,
    decisionsUsed: used + 1,
    decisionsRemaining: Math.max(0, allowance - (used + 1)),
    balanceMicros: balance,
  };
}

/**
 * Add prepaid credit. Idempotent on `dedupeKey`, which is the payment
 * provider's event id in production so a redelivered webhook cannot double-credit.
 */
export async function addCredit(
  tx: PoolClient, workspaceId: string, amountMicros: number,
  dedupeKey: string, detail: Record<string, unknown> = {},
  kind: 'topup' | 'adjustment' = 'topup',
): Promise<{ applied: boolean; balanceMicros: number }> {
  const existing = await tx.query<{ balance_after: number }>(
    'SELECT balance_after FROM ledger_entries WHERE workspace_id = $1 AND dedupe_key = $2',
    [workspaceId, dedupeKey],
  );
  if (existing.rows[0]) {
    const cur = await tx.query<{ credit_micros: number }>(
      'SELECT credit_micros FROM workspaces WHERE id = $1', [workspaceId],
    );
    return { applied: false, balanceMicros: cur.rows[0]?.credit_micros ?? 0 };
  }

  const { rows } = await tx.query<{ credit_micros: number }>(
    `UPDATE workspaces SET credit_micros = credit_micros + $2, updated_at = now()
      WHERE id = $1 RETURNING credit_micros`,
    [workspaceId, amountMicros],
  );
  const balance = rows[0]?.credit_micros ?? 0;

  await tx.query(
    `INSERT INTO ledger_entries
       (workspace_id, kind, delta_micros, balance_after, dedupe_key, detail)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
    [workspaceId, kind, amountMicros, balance, dedupeKey, JSON.stringify(detail)],
  );
  return { applied: true, balanceMicros: balance };
}

/**
 * Receipt for a credit top-up. Fire-and-forget after the transaction commits:
 * a mail problem must never roll back money that was actually received.
 */
export function queueReceipt(
  workspaceId: string, amountMicros: number, method: string, balanceMicros: number,
): void {
  void (async () => {
    const [{ queueEmail }, tpl] = await Promise.all([
      import('./email.js'), import('./email-templates.js'),
    ]);
    const t = tpl.receipt(amountMicros, method, balanceMicros);
    await queueEmail({
      workspaceId, category: 'billing',
      dedupeKey: `receipt:${method}:${amountMicros}:${Date.now()}`,
      subject: t.subject, text: t.text, html: t.html,
    });
  })().catch(() => { /* a receipt is not worth failing a payment over */ });
}

export async function listLedger(
  db: Db, workspaceId: string, limit = 50,
): Promise<Array<{
  kind: string; deltaMicros: number; balanceAfter: number;
  effectId: string | null; createdAt: string; detail: Record<string, unknown>;
}>> {
  const { rows } = await db.query(
    `SELECT kind, delta_micros, balance_after, effect_id, created_at, detail
       FROM ledger_entries WHERE workspace_id = $1
      ORDER BY id DESC LIMIT $2`,
    [workspaceId, Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    kind: r.kind,
    deltaMicros: r.delta_micros,
    balanceAfter: r.balance_after,
    effectId: r.effect_id,
    createdAt: r.created_at.toISOString(),
    detail: r.detail,
  }));
}
