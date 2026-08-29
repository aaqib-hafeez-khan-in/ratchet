import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTx, getPool } from '../db/pool.js';
import { addCredit } from './metering.js';
import { config } from '../lib/config.js';
import { PLANS, type PlanId } from './plans.js';

/**
 * Payment provider boundary.
 *
 * Two adapters share one interface. `test` performs no network I/O and issues
 * no real charge — it exists so the entire credit and entitlement path can be
 * exercised end to end without live payment credentials. `stripe` is wired for
 * signature verification and event handling; it requires STRIPE_SECRET_KEY and
 * STRIPE_WEBHOOK_SECRET, and is inactive until those are set.
 */

export interface CreditPack {
  id: string; label: string; priceMicros: number; creditMicros: number;
}

/** Packs are priced at parity — $1 paid is $1 of credit. Margin is in the meter. */
export const CREDIT_PACKS: CreditPack[] = [
  { id: 'pack_10', label: '$10 credit', priceMicros: 10_000_000, creditMicros: 10_000_000 },
  { id: 'pack_50', label: '$50 credit', priceMicros: 50_000_000, creditMicros: 50_000_000 },
  { id: 'pack_200', label: '$200 credit', priceMicros: 200_000_000, creditMicros: 200_000_000 },
];

export interface CheckoutSession {
  provider: string;
  sessionId: string;
  url: string | null;
  /** True when no real money moves. Always surfaced to the caller. */
  testMode: boolean;
}

export class BillingUnavailable extends Error {
  constructor(msg: string) { super(msg); this.name = 'BillingUnavailable'; }
}

export function packById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

export const stripeConfigured = (): boolean =>
  config.billing.provider === 'stripe'
  && config.billing.stripeSecretKey.length > 0
  && config.billing.stripeWebhookSecret.length > 0;

/**
 * Start a credit purchase. In test mode this returns a session id that can be
 * settled locally via the test-settlement endpoint; no card is charged and no
 * external request is made.
 */
export async function startCheckout(
  workspaceId: string, pack: CreditPack,
): Promise<CheckoutSession> {
  if (stripeConfigured()) {
    // Deliberately not implemented against the live API in this build: doing so
    // untested against real credentials would be exactly the kind of unverified
    // claim this project refuses to make. See docs/handoff/KNOWN_LIMITATIONS.md.
    throw new BillingUnavailable(
      'Stripe credentials are present but the live checkout call is not enabled in this build.');
  }
  return {
    provider: 'test',
    sessionId: `cs_test_${workspaceId}_${pack.id}_${Date.now()}`,
    url: null,
    testMode: true,
  };
}

/**
 * Settle a test-mode purchase. Idempotent on the session id, mirroring exactly
 * how a real provider webhook is deduplicated.
 */
export async function settleTestCheckout(
  workspaceId: string, sessionId: string, pack: CreditPack,
): Promise<{ applied: boolean; balanceMicros: number }> {
  if (stripeConfigured()) {
    throw new BillingUnavailable('Test settlement is disabled when a live provider is configured.');
  }
  return withTx(async (tx) => {
    const already = await tx.query(
      'SELECT id FROM processed_payment_events WHERE id = $1', [sessionId],
    );
    if (already.rows[0]) {
      const cur = await tx.query<{ credit_micros: number }>(
        'SELECT credit_micros FROM workspaces WHERE id = $1', [workspaceId]);
      return { applied: false, balanceMicros: cur.rows[0]?.credit_micros ?? 0 };
    }
    await tx.query(
      `INSERT INTO processed_payment_events (id, provider, workspace_id) VALUES ($1,'test',$2)`,
      [sessionId, workspaceId],
    );
    return addCredit(tx, workspaceId, pack.creditMicros, `checkout:${sessionId}`,
      { pack: pack.id, provider: 'test', testMode: true });
  });
}

/**
 * Verify a Stripe webhook signature (the `t=`/`v1=` scheme) without pulling in
 * the SDK. Constant-time comparison, and a replay window so a captured payload
 * cannot be resubmitted later.
 */
export function verifyStripeSignature(
  payload: string, header: string, secret: string, toleranceSeconds = 300,
  now: number = Date.now(),
): boolean {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;

  const t = Number.parseInt(parts.t ?? '', 10);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Math.floor(now / 1000) - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest();
  let given: Buffer;
  try { given = Buffer.from(v1, 'hex'); } catch { return false; }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** Apply a verified provider event exactly once. */
export async function applyPaymentEvent(
  eventId: string, provider: string, workspaceId: string,
  creditMicros: number, detail: Record<string, unknown>,
): Promise<{ applied: boolean; balanceMicros: number }> {
  return withTx(async (tx) => {
    const seen = await tx.query('SELECT id FROM processed_payment_events WHERE id = $1', [eventId]);
    if (seen.rows[0]) {
      const cur = await tx.query<{ credit_micros: number }>(
        'SELECT credit_micros FROM workspaces WHERE id = $1', [workspaceId]);
      return { applied: false, balanceMicros: cur.rows[0]?.credit_micros ?? 0 };
    }
    await tx.query(
      'INSERT INTO processed_payment_events (id, provider, workspace_id) VALUES ($1,$2,$3)',
      [eventId, provider, workspaceId],
    );
    return addCredit(tx, workspaceId, creditMicros, `payment:${eventId}`, detail);
  });
}

export async function setPlan(workspaceId: string, plan: PlanId): Promise<void> {
  if (!PLANS[plan]) throw new Error(`unknown plan ${plan}`);
  await getPool().query(
    'UPDATE workspaces SET plan = $2, updated_at = now() WHERE id = $1',
    [workspaceId, plan],
  );
}
