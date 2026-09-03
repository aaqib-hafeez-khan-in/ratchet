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

/**
 * Packs are priced at parity — $1 paid is $1 of credit. Margin lives in the
 * meter, not in a spread on the top-up.
 *
 * The smallest pack is $25 because card processing (2.9% + $0.30) costs 5.9% of
 * a $10 top-up and only 3.9% of a $25 one. A pack small enough to lose 6% to
 * fees is a pack that should not exist.
 */
export const CREDIT_PACKS: CreditPack[] = [
  { id: 'pack_25', label: '$25 credit', priceMicros: 25_000_000, creditMicros: 25_000_000 },
  { id: 'pack_100', label: '$100 credit', priceMicros: 100_000_000, creditMicros: 100_000_000 },
  { id: 'pack_500', label: '$500 credit', priceMicros: 500_000_000, creditMicros: 500_000_000 },
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

/** Stripe is the selected provider and we can call its API. */
export const stripeSelected = (): boolean =>
  config.billing.provider === 'stripe' && config.billing.stripeSecretKey.length > 0;

/**
 * Fully configured: we can both take a payment AND receive the signed
 * confirmation that lets us credit it.
 *
 * Both halves are required before checkout is allowed. Selling without the
 * webhook secret would let a customer pay and never receive credit, which is
 * strictly worse than declining to sell — so this is a deliberate hard gate,
 * not an oversight.
 */
export const stripeConfigured = (): boolean =>
  stripeSelected() && config.billing.stripeWebhookSecret.length > 0;

/** What is still missing, for an actionable error rather than a silent fallback. */
export function stripeSetupGap(): string | null {
  if (config.billing.provider !== 'stripe') return null;
  if (config.billing.stripeSecretKey.length === 0) return 'STRIPE_SECRET_KEY';
  if (config.billing.stripeWebhookSecret.length === 0) return 'STRIPE_WEBHOOK_SECRET';
  return null;
}

/**
 * Whether the key in use is a Stripe test-mode key. Surfaced to callers so a
 * UI can never imply a real charge when none is possible.
 */
export const stripeIsTestKey = (): boolean =>
  config.billing.stripeSecretKey.startsWith('sk_test_');

const STRIPE_API = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(readonly status: number, readonly stripeCode: string | undefined, msg: string) {
    super(msg);
    this.name = 'StripeError';
  }
}

/**
 * Minimal Stripe form-encoded POST. Stripe's API is form-encoded with bracket
 * notation for nested values, so a flat key/value map is all that is needed —
 * no SDK, and no dependency that has to be tracked for advisories.
 *
 * The host is a hard-coded constant, never caller-derived, so none of the SSRF
 * machinery in src/lib/ssrf.ts applies here.
 */
async function stripePost(
  path: string, params: Record<string, string>, idempotencyKey: string,
): Promise<any> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.billing.stripeSecretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      // Stripe deduplicates on this, so a retried request cannot create a
      // second session (and, for charges, cannot double-charge).
      'idempotency-key': idempotencyKey,
      'stripe-version': '2024-06-20',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = {}; }

  if (!res.ok) {
    const err = data?.error ?? {};
    // Stripe's message is safe to surface: it describes the caller's request,
    // never our credentials.
    throw new StripeError(res.status, err.code,
      err.message ?? `Stripe returned ${res.status}`);
  }
  return data;
}

/**
 * Build the Checkout Session parameters. Pure and exported so the tax and
 * metadata wiring can be asserted without touching the network — the metadata
 * in particular is load-bearing: without it a completed payment cannot be
 * attributed to a workspace.
 */
export function buildCheckoutParams(
  workspaceId: string, pack: CreditPack,
  opts: { saveCard?: boolean; existingCustomerId?: string | null } = {},
): Record<string, string> {
  // Stripe works in the currency's smallest unit; our micros are 1e-6 USD.
  const amountCents = Math.round(pack.priceMicros / 10_000);
  const base = config.publicUrl.replace(/\/$/, '');

  // Tax is added on top of the pack price; the credit granted is always the
  // pack's face value, never the taxed total. Paying $10.80 for $10 of credit
  // is correct — the $0.80 is tax, not something the customer bought from us.
  const tax: Record<string, string> = config.billing.stripeAutomaticTax
    ? {
        'automatic_tax[enabled]': 'true',
        // Stripe cannot determine a jurisdiction without an address.
        billing_address_collection: 'required',
      }
    : {};

  return {
    mode: 'payment',
    ...tax,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': `Ratchet credit — ${pack.label}`,
    'line_items[0][price_data][product_data][description]':
      'Prepaid credit for gated effects. Drawn down only past your plan allowance.',
    success_url: `${base}/console?checkout=success`,
    cancel_url: `${base}/console?checkout=cancelled`,
    client_reference_id: workspaceId,
    // The webhook reads both of these. Without them a completed payment cannot
    // be attributed, so they are not optional.
    'metadata[workspace_id]': workspaceId,
    'metadata[pack_id]': pack.id,
    'payment_intent_data[metadata][workspace_id]': workspaceId,
    'payment_intent_data[metadata][pack_id]': pack.id,
    ...savedCard(opts),
  };
}

/**
 * Keep the card for later, but only when the buyer said so.
 *
 * `setup_future_usage: 'off_session'` is what makes automatic top-up possible
 * for somebody who never subscribed: it stores the payment method against a
 * Stripe Customer so it can be charged later with nobody present. Stripe also
 * surfaces the mandate wording on its own page, which is where consent for a
 * future charge belongs.
 *
 * It is NOT set by default, and that is the whole design. Silently keeping a
 * card because it was convenient for us is the kind of thing a customer finds
 * out about from a statement. The caller has to ask.
 *
 * A workspace that already has a Stripe Customer — a subscriber, or anyone who
 * saved a card before — is passed that customer instead of creating another.
 * Two customers for one workspace would split the payment methods between them,
 * and auto-recharge would then charge whichever one it happened to find.
 */
function savedCard(opts: { saveCard?: boolean; existingCustomerId?: string | null }) {
  if (!opts.saveCard) return {};
  return {
    'payment_intent_data[setup_future_usage]': 'off_session',
    ...(opts.existingCustomerId
      ? { customer: opts.existingCustomerId }
      : { customer_creation: 'always' }),
  };
}

/**
 * Remember which Stripe Customer holds this workspace's saved cards.
 *
 * Written from the signed webhook, never from the browser's return: a customer
 * id arriving on a redirect is a claim by whoever opened the URL, and this one
 * decides whose card an unattended charge later lands on.
 *
 * COALESCE keeps the first customer a workspace ever had. A workspace that
 * subscribes and later saves a card during a credit purchase must end up with
 * one customer holding both payment methods, not two holding one each — with
 * two, automatic top-up would charge whichever it happened to find.
 */
export async function rememberCustomer(
  workspaceId: string, customerId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE workspaces
        SET stripe_customer_id = COALESCE(stripe_customer_id, $2)
      WHERE id = $1`, [workspaceId, customerId]);
}

/**
 * Charge a card that is already on file, with nobody present.
 *
 * The only place in this codebase that moves money without a human in the loop,
 * so the parameters are deliberate:
 *
 *   `off_session: true` tells Stripe there is no one to answer a 3-D Secure
 *   prompt. Without it a card needing authentication silently succeeds in a way
 *   that later reverses; with it Stripe fails immediately and says so, which is
 *   the outcome we can actually act on.
 *
 *   `confirm: true` charges in one call rather than creating an intent that
 *   something else must remember to confirm. One call is one thing to make
 *   idempotent.
 *
 *   `idempotencyKey` is the recharge row id, which exists in our database
 *   before this is called and is unique by index. A retried request — a
 *   timeout, a worker restart mid-flight — reaches Stripe with the same key and
 *   returns the original charge instead of making a second one.
 *
 * The metadata is not optional. Credit is granted by the signed webhook using
 * exactly these fields, the same path a human checkout takes; without them a
 * successful charge could not be attributed and the customer would be billed
 * for credit they never received.
 */
export async function chargeSavedCard(args: {
  workspaceId: string;
  customerId: string;
  pack: CreditPack;
  idempotencyKey: string;
}): Promise<{ paymentIntentId: string; status: string }> {
  const gap = stripeSetupGap();
  if (gap) throw new StripeError(400, 'stripe_not_configured', gap);

  const intent = await stripePost('/payment_intents', {
    amount: String(Math.round(args.pack.priceMicros / 10_000)),
    currency: 'usd',
    customer: args.customerId,
    off_session: 'true',
    confirm: 'true',
    description: `Ratchet automatic top-up — ${args.pack.label}`,
    'metadata[workspace_id]': args.workspaceId,
    'metadata[pack_id]': args.pack.id,
    'metadata[auto_recharge]': 'true',
  }, args.idempotencyKey);

  return { paymentIntentId: String(intent.id), status: String(intent.status) };
}

/**
 * Start a subscription to a paid plan.
 *
 * Separate from credit purchases because the two are genuinely different
 * products: a subscription buys monthly included volume, credit buys overage
 * beyond it. Conflating them would make the invoice unreadable.
 *
 * The plan is NOT granted here. It is granted when the signed webhook confirms
 * the subscription, for the same reason credit is: a browser returning to a
 * success URL is not proof that payment succeeded.
 */
export async function startSubscription(
  workspaceId: string, planId: PlanId,
): Promise<CheckoutSession> {
  /**
   * The guard for a sold tier, and it is here rather than in the route.
   *
   * Enterprise has no list price — monthlyPriceMicros is 0 because there is no
   * public number, not because it is free — so a checkout for it would create a
   * subscription at nothing per month with ten times Scale's limits. The route's
   * schema also constrains the enum, but a schema is a copy of this fact and
   * copies drift. This is the one that has to hold.
   */
  const plan = PLANS[planId];
  if (!plan) {
    throw new BillingUnavailable(`Unknown plan "${planId}".`);
  }
  if (!plan.selfServe) {
    throw new BillingUnavailable(
      `${plan.name} is not sold through checkout. It is priced against what you are `
      + 'protecting rather than a list rate, so it is arranged directly — write to '
      + 'hello@ratchetgate.com.');
  }

  const gap = stripeSetupGap();
  if (gap) {
    throw new BillingUnavailable(
      `Stripe is selected but ${gap} is not set. Subscriptions are disabled until it is.`);
  }
  if (!stripeConfigured()) {
    throw new BillingUnavailable(
      'No payment provider is configured, so plans cannot be purchased on this instance.');
  }

  const base = config.publicUrl.replace(/\/$/, '');
  const session = await stripePost('/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(plan.monthlyPriceMicros / 10_000)),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': `Ratchet ${plan.name}`,
    'line_items[0][price_data][product_data][description]':
      `${plan.includedEffects.toLocaleString('en-US')} gated effects per month, then `
      + `$${(plan.overageMicrosPerEffect * 1000 / 1e6).toFixed(2)} per 1,000 from prepaid credit.`,
    success_url: `${base}/console?subscribed=1`,
    cancel_url: `${base}/console?subscribe=cancelled`,
    client_reference_id: workspaceId,
    'metadata[workspace_id]': workspaceId,
    'metadata[plan_id]': planId,
    'metadata[kind]': 'subscription',
    'subscription_data[metadata][workspace_id]': workspaceId,
    'subscription_data[metadata][plan_id]': planId,
  }, `subscribe:${workspaceId}:${planId}:${Math.floor(Date.now() / 60_000)}`);

  return {
    provider: 'stripe',
    sessionId: session.id,
    url: session.url ?? null,
    testMode: stripeIsTestKey(),
  };
}

/**
 * Apply a subscription state change. Idempotent on the provider event id.
 *
 * `past_due` deliberately keeps the plan: cutting a paying customer's
 * entitlement the moment a card declines would push their agents into the
 * duplicate-execution failure this service exists to prevent, over a billing
 * problem that usually resolves itself.
 */
export async function applySubscriptionEvent(args: {
  eventId: string;
  workspaceId: string;
  planId: string;
  subscriptionId: string | null;
  customerId: string | null;
  status: 'active' | 'past_due' | 'canceled' | 'incomplete';
  endsAt: Date | null;
}): Promise<{ applied: boolean; plan: string }> {
  return withTx(async (tx) => {
    const seen = await tx.query('SELECT id FROM processed_payment_events WHERE id = $1',
      [args.eventId]);
    if (seen.rows[0]) {
      const cur = await tx.query<{ plan: string }>(
        'SELECT plan FROM workspaces WHERE id = $1', [args.workspaceId]);
      return { applied: false, plan: cur.rows[0]?.plan ?? 'free' };
    }
    await tx.query(
      'INSERT INTO processed_payment_events (id, provider, workspace_id) VALUES ($1,$2,$3)',
      [args.eventId, 'stripe', args.workspaceId]);

    const entitled = args.status === 'active' || args.status === 'past_due';
    const plan = entitled ? args.planId : 'free';

    await tx.query(
      `UPDATE workspaces
          SET plan = $2, stripe_subscription_id = COALESCE($3, stripe_subscription_id),
              stripe_customer_id = COALESCE($4, stripe_customer_id),
              subscription_status = $5, subscription_ends_at = $6, updated_at = now()
        WHERE id = $1`,
      [args.workspaceId, plan, args.subscriptionId, args.customerId, args.status, args.endsAt]);

    await tx.query(
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,'billing.subscription_changed','system',$2,$3)`,
      [args.workspaceId, args.subscriptionId,
       JSON.stringify({ status: args.status, plan, endsAt: args.endsAt })]);

    return { applied: true, plan };
  });
}

/**
 * Start a credit purchase.
 *
 * With Stripe configured this creates a real Checkout Session and returns the
 * hosted URL. Card details are entered on Stripe's own page and never reach
 * Ratchet. Credit is applied only when the signed `checkout.session.completed`
 * webhook arrives — never here, and never on the client's say-so, because the
 * browser returning to a success URL is not proof that payment settled.
 *
 * Without Stripe configured, the test adapter returns a session id that can be
 * settled locally; no card is charged and no external request is made.
 */
export async function startCheckout(
  workspaceId: string, pack: CreditPack,
  opts: { saveCard?: boolean } = {},
): Promise<CheckoutSession> {
  const gap = stripeSetupGap();
  if (gap) {
    throw new BillingUnavailable(
      `Stripe is selected but ${gap} is not set. Checkout is disabled until it is: taking a `
      + 'payment we cannot confirm would leave the customer charged and uncredited.');
  }
  if (!stripeConfigured()) {
    return {
      provider: 'test',
      sessionId: `cs_test_${workspaceId}_${pack.id}_${Date.now()}`,
      url: null,
      testMode: true,
    };
  }

  // Reuse the workspace's Stripe Customer if it has one, so saving a card does
  // not create a second customer holding a second set of payment methods.
  const { rows } = await getPool().query<{ stripe_customer_id: string | null }>(
    'SELECT stripe_customer_id FROM workspaces WHERE id = $1', [workspaceId]);

  const session = await stripePost(
    '/checkout/sessions',
    buildCheckoutParams(workspaceId, pack, {
      saveCard: opts.saveCard,
      existingCustomerId: rows[0]?.stripe_customer_id ?? null,
    }),
    // One session per workspace+pack per minute; a double-clicked button
    // reuses the same session rather than creating a second one. The save-card
    // choice is part of the key: asking for the same pack with and without it
    // are different requests and must not collapse into one session.
    `checkout:${workspaceId}:${pack.id}:${opts.saveCard ? 'save' : 'nosave'}:`
      + `${Math.floor(Date.now() / 60_000)}`,
  );

  return {
    provider: 'stripe',
    sessionId: session.id,
    url: session.url ?? null,
    testMode: stripeIsTestKey(),
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
  paymentReference?: string | null,
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
    const r = await addCredit(tx, workspaceId, creditMicros, `payment:${eventId}`, detail);
    if (paymentReference) {
      await tx.query(
        'UPDATE ledger_entries SET payment_reference = $2 WHERE workspace_id = $1 AND dedupe_key = $3',
        [workspaceId, paymentReference, `payment:${eventId}`]);
    }
    return r;
  });
}

/**
 * Reverse credit after a refund or a dispute.
 *
 * A refund returns the customer's money; leaving the credit in place would let
 * them keep the product too. The reversal is a compensating ledger entry, never
 * an edit of the original — the ledger stays append-only and continues to
 * explain the balance.
 *
 * The balance is allowed to go negative. If the credit was already spent, the
 * account genuinely owes it, and clamping at zero would silently discard that
 * fact. A negative balance blocks new gated effects through the existing
 * insufficient-credit path, which is the correct consequence.
 */
export async function reverseCredit(args: {
  eventId: string;
  provider: string;
  paymentReference: string;
  amountMicros: number;
  reason: 'refund' | 'dispute';
  detail?: Record<string, unknown>;
}): Promise<{ applied: boolean; workspaceId: string | null; balanceMicros: number | null }> {
  return withTx(async (tx) => {
    // Idempotent on the provider's event id, exactly like crediting.
    const seen = await tx.query('SELECT id FROM processed_payment_events WHERE id = $1',
      [args.eventId]);
    if (seen.rows[0]) return { applied: false, workspaceId: null, balanceMicros: null };

    // Find the credit this payment created.
    const { rows } = await tx.query<{ workspace_id: string; delta_micros: number }>(
      `SELECT workspace_id, delta_micros FROM ledger_entries
        WHERE payment_reference = $1 AND kind = 'topup'
        ORDER BY id LIMIT 1`,
      [args.paymentReference],
    );
    const original = rows[0];
    if (!original) {
      // A charge we never credited — someone else's payment, or a mode we do
      // not handle. Acknowledge without inventing a reversal.
      return { applied: false, workspaceId: null, balanceMicros: null };
    }

    await tx.query(
      'INSERT INTO processed_payment_events (id, provider, workspace_id) VALUES ($1,$2,$3)',
      [args.eventId, args.provider, original.workspace_id]);

    // Never reverse more than was credited, even on a strange provider payload.
    const amount = Math.min(args.amountMicros, original.delta_micros);

    const updated = await tx.query<{ credit_micros: number }>(
      `UPDATE workspaces SET credit_micros = credit_micros - $2, updated_at = now()
        WHERE id = $1 RETURNING credit_micros`,
      [original.workspace_id, amount]);
    const balance = updated.rows[0]?.credit_micros ?? 0;

    await tx.query(
      `INSERT INTO ledger_entries
         (workspace_id, kind, delta_micros, balance_after, dedupe_key, detail, payment_reference)
       VALUES ($1,'adjustment',$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
      [original.workspace_id, -amount, balance, `reversal:${args.eventId}`,
       JSON.stringify({ reason: args.reason, provider: args.provider, ...(args.detail ?? {}) }),
       args.paymentReference]);

    await tx.query(
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,$2,'system',$3,$4)`,
      [original.workspace_id, `billing.${args.reason}`, args.paymentReference,
       JSON.stringify({ reversedMicros: amount, balanceAfter: balance })]);

    return { applied: true, workspaceId: original.workspace_id, balanceMicros: balance };
  });
}

export async function setPlan(workspaceId: string, plan: PlanId): Promise<void> {
  if (!PLANS[plan]) throw new Error(`unknown plan ${plan}`);
  await getPool().query(
    'UPDATE workspaces SET plan = $2, updated_at = now() WHERE id = $1',
    [workspaceId, plan],
  );
}
