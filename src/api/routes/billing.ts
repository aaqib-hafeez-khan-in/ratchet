import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { errors, ApiError } from '../../lib/errors.js';
import { wsOf, actorOf } from '../plugins/auth.js';
import { audit } from '../../domain/audit.js';
import { configure as configureAutoRecharge, readSettings,
         history as rechargeHistory, MAX_RECHARGES_PER_DAY } from '../../domain/auto-recharge.js';
import { rememberCustomer } from '../../domain/billing.js';
import { CREDIT_PACKS, packById, startCheckout, settleTestCheckout,
         verifyStripeSignature, applyPaymentEvent, stripeConfigured,
         stripeIsTestKey, stripeSetupGap, reverseCredit, startSubscription,
         applySubscriptionEvent,
         BillingUnavailable, StripeError } from '../../domain/billing.js';
import { PLANS, SELF_SERVE_PLAN_IDS, type PlanId } from '../../domain/plans.js';
import { cryptoEnabled, listAssets, createIntent, listIntents, submitTransaction,
         destinationFor, CryptoUnavailable } from '../../domain/crypto.js';
import { verifyTransfer } from '../../worker/verify.js';
import { config } from '../../lib/config.js';
import { errorResponses } from '../schemas.js';

function providerStatus() {
  const gap = stripeSetupGap();
  if (gap) {
    return {
      name: 'stripe',
      live: false,
      test_mode: true,
      setup_incomplete: gap,
      note: `Stripe is selected but ${gap} is not set. Checkout is disabled until it is — `
          + 'taking a payment that cannot be confirmed would leave a customer charged '
          + 'and uncredited.',
    };
  }
  if (!stripeConfigured()) {
    return {
      name: 'test',
      live: false,
      test_mode: true,
      note: 'Running the built-in test adapter: no card is charged and no external '
          + 'request is made. Credit is applied through a local settlement endpoint.',
    };
  }
  if (stripeIsTestKey()) {
    return {
      name: 'stripe',
      live: false,
      test_mode: true,
      note: 'Stripe test mode. Real Checkout Sessions are created and the signed webhook '
          + 'path runs end to end, but no card is charged and no real money moves. '
          + 'Use Stripe\'s test cards, e.g. 4242 4242 4242 4242.',
    };
  }
  return {
    name: 'stripe',
    live: true,
    test_mode: false,
    note: 'Live payments are enabled. Card details are entered on Stripe\'s own page '
        + 'and never reach Ratchet.',
  };
}

export default async function billingRoutes(app: FastifyInstance) {
  app.get('/billing/plans', {
    schema: {
      tags: ['Billing'], operationId: 'listPlans',
      summary: 'Plans and credit packs',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => ({
    meter: {
      unit: 'gated_effect',
      definition: 'One newly created effect — the first begin() for a given (effect_type, idempotency_key).',
      free_operations: [
        'duplicate suppression', 'in-flight checks', 'retries of the same key',
        'outcome reports', 'lookups and reads', 'policy changes', 'webhook deliveries',
      ],
    },
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, name: p.name,
      monthly_price_micros: p.monthlyPriceMicros,
      included_effects: p.includedEffects,
      overage_micros_per_effect: p.overageMicrosPerEffect,
      rate_limit_per_minute: p.rateLimitPerMinute,
      max_retention_days: p.maxRetentionDays,
      max_api_keys: p.maxApiKeys,
        max_webhook_endpoints: p.maxWebhookEndpoints,
        // Whether a customer can put themselves on it. The pricing page renders
        // a checkout button or a conversation from this, rather than from a
        // hardcoded plan id that would go stale the next time a tier is added.
        self_serve: p.selfServe,
      // Published so the pricing page is generated from what is enforced rather
      // than written beside it. A tier table that drifts from the code is the
      // one kind of marketing copy that is also a broken promise.
      capabilities: {
        reversible_groups: p.capabilities.reversibleGroups,
        signed_receipts: p.capabilities.signedReceipts,
        reconciliation: p.capabilities.reconciliation,
      },
    })),
    credit_packs: CREDIT_PACKS.map((c) => ({
      id: c.id, label: c.label,
      price_micros: c.priceMicros, credit_micros: c.creditMicros,
    })),
    // Three distinct states, reported precisely. A Stripe *test* key is not
    // "live" — it creates real Checkout Sessions but moves no real money, and
    // calling that live would be the kind of claim this service refuses to make.
    provider: providerStatus(),
    crypto: {
      enabled: cryptoEnabled(),
      custody: 'none',
      assets_url: `${config.publicUrl}/v1/billing/crypto/assets`,
    },
  }));

  // ----------------------------------------------------------------- crypto
  app.get('/billing/crypto/assets', {
    schema: {
      tags: ['Billing'], operationId: 'listCryptoAssets',
      summary: 'Assets this instance accepts, and on what terms',
      description: 'Which assets are acceptable is operator policy — a payer cannot introduce one '
        + 'or set its terms. Ratchet is non-custodial: it holds no key and takes custody of nothing.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const assets = await listAssets(getPool(), true);
    return {
      enabled: cryptoEnabled(),
      custody: 'none — payments go directly to an address the operator controls',
      note: cryptoEnabled()
        ? 'Quotes are struck in USD. Credit granted is always the USD amount, never a token '
          + 'amount, so a price move between quote and settlement cannot mint credit.'
        : 'Crypto payments are not configured on this instance.',
      chains: ['solana', 'ethereum', 'bitcoin'].map((c) => ({
        chain: c,
        destination: destinationFor(c) || null,
        configured: destinationFor(c).length > 0,
      })),
      assets: assets.map((a) => ({
        chain: a.chain, symbol: a.symbol, token_mint: a.tokenMint, decimals: a.decimals,
        stable: a.isStable, quote_ttl_seconds: a.quoteTtlSeconds,
        volatility_haircut_bps: a.volatilityBps,
        min_usd_micros: a.minUsdMicros, required_confirmations: a.requiredConfirmations,
        attribution: a.attribution,
        attribution_note: a.attribution === 'memo'
          ? 'Include the memo; credited automatically once confirmed.'
          : 'No memo on this chain — submit the transaction hash afterwards.',
      })),
    };
  });

  app.post('/billing/crypto/intents', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'createCryptoIntent',
      summary: 'Quote a crypto payment for prepaid credit',
      description: 'Returns an address, an exact token amount, and a memo. Credit is applied only '
        + 'after the transfer confirms on-chain. A transfer short of the quote is not credited.',
      body: {
        type: 'object', required: ['token_mint', 'usd_micros'], additionalProperties: false,
        properties: {
          token_mint: { type: 'string', maxLength: 64 },
          chain: { type: 'string', enum: ['solana', 'ethereum', 'bitcoin'] },
          usd_micros: { type: 'integer', minimum: 1, maximum: 100_000_000_000 },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        503: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const b = req.body as { token_mint: string; usd_micros: number; chain?: string };
    try {
      const i = await createIntent({
        workspaceId: wsOf(req), tokenMint: b.token_mint,
        usdMicros: b.usd_micros, chain: b.chain,
      });
      return {
        intent_id: i.id, chain: i.chain, symbol: i.symbol,
        destination: i.destination, amount: i.displayAmount,
        amount_base_units: i.tokenAmount, decimals: i.tokenDecimals,
        usd_micros: i.usdMicros, quoted_rate_usd: i.quotedRateUsd,
        memo: i.memo, state: i.state, expires_at: i.expiresAt,
        instructions: i.instructions,
      };
    } catch (err) {
      if (err instanceof CryptoUnavailable) {
        reply.code(503);
        return { error: { code: 'crypto_unavailable', message: err.message } };
      }
      throw err;
    }
  });

  app.post('/billing/crypto/intents/:intentId/submit', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'submitCryptoTransaction',
      summary: 'Submit a transaction hash for a chain without a memo',
      description:
        'Ethereum, Base, and Bitcoin transfers carry no memo, so a payment cannot identify itself. '
        + 'Submit the transaction hash and Ratchet verifies it on-chain: destination, asset, '
        + 'amount, and confirmations are all re-derived rather than trusted. A transaction can '
        + 'only ever settle one payment.',
      params: { type: 'object', required: ['intentId'], properties: { intentId: { type: 'string' } } },
      body: {
        type: 'object', required: ['tx_hash'], additionalProperties: false,
        properties: { tx_hash: { type: 'string', minLength: 64, maxLength: 66 } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const r = await submitTransaction({
      workspaceId: wsOf(req),
      intentId: (req.params as { intentId: string }).intentId,
      txHash: (req.body as { tx_hash: string }).tx_hash,
      verify: verifyTransfer,
    });
    return {
      credited: r.credited, state: r.state,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.state === 'confirming'
        ? { note: 'Not settled yet. Submit again once it has more confirmations.' } : {}),
    };
  });

  app.get('/billing/crypto/intents', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'listCryptoIntents',
      summary: 'Recent crypto payment intents and their state',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => ({ data: await listIntents(getPool(), wsOf(req)) }));

  app.post('/billing/checkout', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'startCheckout',
      summary: 'Begin a prepaid credit purchase',
      description:
        'Buys prepaid credit. Set save_card to keep the payment method on file so '
        + 'automatic top-up can use it later — it defaults to false, and the consent '
        + 'wording for a future charge is shown on Stripe\'s own page.',
      body: {
        type: 'object', required: ['pack_id'], additionalProperties: false,
        properties: {
          pack_id: { type: 'string', enum: CREDIT_PACKS.map((p) => p.id) },
          // Default false, and deliberately not inferred from anything. Keeping
          // somebody's card because it would be convenient for us later is how
          // a customer finds out from a statement.
          save_card: { type: 'boolean', default: false },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const body = req.body as { pack_id: string; save_card?: boolean };
    const pack = packById(body.pack_id);
    if (!pack) throw errors.invalid('Unknown credit pack.');
    try {
      const s = await startCheckout(wsOf(req), pack, { saveCard: body.save_card === true });
      return {
        provider: s.provider, session_id: s.sessionId, url: s.url,
        test_mode: s.testMode, pack_id: pack.id, credit_micros: pack.creditMicros,
        ...(s.testMode ? {
          settle_url: `${config.publicUrl}/v1/billing/test/settle`,
          note: 'Test mode: POST the session_id to settle_url to apply credit. No money moves.',
        } : {}),
      };
    } catch (err) {
      if (err instanceof BillingUnavailable) {
        throw new ApiError(503, 'billing_unavailable', err.message);
      }
      if (err instanceof StripeError) {
        // Stripe's own message describes the request, not our credentials, so
        // it is safe to pass through — and far more useful than "internal error".
        req.log.error({ status: err.status, code: err.stripeCode }, 'stripe checkout failed');
        throw new ApiError(502, 'payment_provider_error',
          `The payment provider rejected the request: ${err.message}`,
          { provider: 'stripe', provider_code: err.stripeCode ?? null });
      }
      throw err;
    }
  });

  app.post('/billing/subscribe', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'startSubscription',
      summary: 'Subscribe to a paid plan',
      description: 'Returns a hosted checkout URL. The plan is granted when the signed webhook '
        + 'confirms the subscription — never on the browser returning to the success URL.',
      body: {
        type: 'object', required: ['plan_id'], additionalProperties: false,
        // Derived, not written out: a plan that is not self-serve must never
        // become purchasable because someone added it to PLANS and forgot a
        // route. The domain refuses it too; this makes the OpenAPI document
        // tell the truth about which plans a caller may actually buy.
        properties: { plan_id: { type: 'string', enum: SELF_SERVE_PLAN_IDS } },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        503: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    try {
      const s = await startSubscription(wsOf(req), (req.body as { plan_id: PlanId }).plan_id);
      return { provider: s.provider, session_id: s.sessionId, url: s.url, test_mode: s.testMode };
    } catch (err) {
      if (err instanceof BillingUnavailable) {
        reply.code(503);
        return { error: { code: 'billing_unavailable', message: err.message } };
      }
      if (err instanceof StripeError) {
        throw new ApiError(502, 'payment_provider_error',
          `The payment provider rejected the request: ${err.message}`);
      }
      throw err;
    }
  });

  app.post('/billing/test/settle', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'settleTestCheckout',
      summary: 'Settle a test-mode credit purchase (no real charge)',
      description: 'Available only while the test billing adapter is active. Idempotent on session_id, ' +
        'exactly as a live provider webhook would be.',
      body: {
        type: 'object', required: ['session_id', 'pack_id'], additionalProperties: false,
        properties: {
          session_id: { type: 'string', maxLength: 200 },
          pack_id: { type: 'string', enum: CREDIT_PACKS.map((p) => p.id) },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const b = req.body as { session_id: string; pack_id: string };
    const pack = packById(b.pack_id);
    if (!pack) throw errors.invalid('Unknown credit pack.');
    const workspaceId = wsOf(req);
    if (!b.session_id.includes(workspaceId)) {
      throw errors.forbidden('That checkout session does not belong to this workspace.');
    }
    try {
      const r = await settleTestCheckout(workspaceId, b.session_id, pack);
      await audit(getPool(), workspaceId, 'billing.test_settled', actorOf(req), b.session_id,
        { pack: pack.id, applied: r.applied });
      return { applied: r.applied, credit_micros: r.balanceMicros, test_mode: true };
    } catch (err) {
      if (err instanceof BillingUnavailable) {
        throw new ApiError(503, 'billing_unavailable', err.message);
      }
      throw err;
    }
  });

  // Signature-verified provider callback. Unauthenticated by design — the HMAC
  // over the raw body IS the authentication.
  /**
   * Automatic top-up settings.
   *
   * Guarded like every other billing write: a console session or an admin key,
   * never an agent's key. An agent that could switch on automatic charging of
   * its owner's card would be able to fund its own overspending, which is the
   * same failure as an agent raising its own budget ceiling and is refused for
   * the same reason.
   */
  app.get('/billing/auto-recharge', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'getAutoRecharge',
      summary: 'Automatic top-up settings and recent attempts',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const { rows } = await getPool().query(
      `SELECT auto_recharge_enabled, auto_recharge_threshold_micros,
              auto_recharge_pack_id, auto_recharge_disabled_reason,
              stripe_customer_id
         FROM workspaces WHERE id = $1`, [req.auth!.workspaceId]);
    const row = rows[0];
    if (!row) throw errors.notFound('workspace');
    const settings = readSettings(row as never);
    return {
      enabled: settings.enabled,
      threshold_micros: settings.thresholdMicros,
      pack_id: settings.packId,
      disabled_reason: settings.disabledReason,
      // Stated plainly, because "enable" will otherwise fail for a reason the
      // operator cannot see from this screen.
      card_on_file: row.stripe_customer_id !== null,
      max_per_day: MAX_RECHARGES_PER_DAY,
      recent: (await rechargeHistory(req.auth!.workspaceId)).map((r) => ({
        id: r.id, pack_id: r.packId, amount_micros: r.amountMicros,
        state: r.state, failure_reason: r.failureReason, created_at: r.createdAt,
      })),
    };
  });

  app.put('/billing/auto-recharge', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'setAutoRecharge',
      summary: 'Turn automatic top-up on or off',
      description:
        'When enabled, credit is bought automatically once the balance falls below '
        + 'threshold_micros. Requires a card already on file — this endpoint never '
        + 'collects card details. Capped at a small number of charges a day whatever '
        + 'the settings say, so a runaway loop drains an allowance rather than a card.',
      body: {
        type: 'object', required: ['enabled'], additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          threshold_micros: { type: 'integer', minimum: 1 },
          pack_id: { type: 'string', enum: CREDIT_PACKS.map((p) => p.id) },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const b = req.body as { enabled: boolean; threshold_micros?: number; pack_id?: string };
    const s = await configureAutoRecharge(req.auth!.workspaceId, {
      enabled: b.enabled,
      thresholdMicros: b.threshold_micros,
      packId: b.pack_id,
    });
    return {
      enabled: s.enabled, threshold_micros: s.thresholdMicros,
      pack_id: s.packId, disabled_reason: s.disabledReason,
    };
  });

  app.post('/billing/webhook/stripe', {
    config: { rawBody: true },
    schema: {
      tags: ['Billing'], operationId: 'stripeWebhook',
      summary: 'Stripe webhook receiver (signature-verified)',
      response: {
        200: { type: 'object', additionalProperties: true },
        503: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    if (!stripeConfigured()) {
      reply.code(503);
      return { error: { code: 'billing_unavailable', message: 'No live payment provider is configured.' } };
    }
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string'
        || !verifyStripeSignature(raw, sig, config.billing.stripeWebhookSecret)) {
      reply.code(400);
      return { error: { code: 'invalid_signature', message: 'Signature verification failed.' } };
    }
    let event: any;
    try { event = JSON.parse(raw); } catch {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'Body is not valid JSON.' } };
    }
    const obj = event.data?.object ?? {};

    // ---- subscriptions ---------------------------------------------------
    if (event.type === 'customer.subscription.updated'
        || event.type === 'customer.subscription.deleted'
        || event.type === 'customer.subscription.created') {
      const workspaceId = obj.metadata?.workspace_id;
      const planId = obj.metadata?.plan_id ?? 'pro';
      if (!workspaceId) return { received: true, ignored: 'subscription without workspace_id' };
      const status = event.type === 'customer.subscription.deleted'
        ? 'canceled'
        : ({ active: 'active', past_due: 'past_due', canceled: 'canceled',
             trialing: 'active', unpaid: 'past_due' } as Record<string, any>)[obj.status]
          ?? 'incomplete';
      const r = await applySubscriptionEvent({
        eventId: event.id, workspaceId, planId,
        subscriptionId: typeof obj.id === 'string' ? obj.id : null,
        customerId: typeof obj.customer === 'string' ? obj.customer : null,
        status,
        endsAt: obj.current_period_end ? new Date(obj.current_period_end * 1000) : null,
      });
      return { received: true, applied: r.applied, plan: r.plan };
    }

    // ---- money in -------------------------------------------------------
    if (event.type === 'checkout.session.completed') {
      // A subscription checkout grants the plan through the subscription
      // events above; there is no credit to apply here.
      if (obj.mode === 'subscription') {
        return { received: true, ignored: 'subscription checkout — plan granted by subscription events' };
      }
      const workspaceId = obj.metadata?.workspace_id;
      const packId = obj.metadata?.pack_id;
      const pack = packId ? packById(packId) : undefined;
      if (!workspaceId || !pack) {
        reply.code(400);
        return { error: { code: 'invalid_request',
                          message: 'Event is missing workspace_id or pack_id metadata.' } };
      }
      // The payment intent is the durable link a later refund uses to find
      // this credit, so it is recorded now rather than reconstructed later.
      const paymentRef = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;

      // If the buyer asked us to keep the card, this is where we learn where
      // Stripe put it. Recorded from the signed event rather than the browser
      // redirect, because this value decides whose card an unattended charge
      // later lands on.
      if (typeof obj.customer === 'string' && obj.customer) {
        await rememberCustomer(workspaceId, obj.customer);
      }
      const r = await applyPaymentEvent(event.id, 'stripe', workspaceId, pack.creditMicros,
        { pack: pack.id, provider: 'stripe' }, paymentRef);
      return { received: true, applied: r.applied };
    }

    // An automatic top-up. Credit is granted here rather than by the worker
    // that made the charge, so there is exactly one path that creates money
    // and it is the signed, idempotent one a human checkout already uses.
    if (event.type === 'payment_intent.succeeded' && obj.metadata?.auto_recharge === 'true') {
      const workspaceId = obj.metadata?.workspace_id;
      const packId = obj.metadata?.pack_id;
      const pack = packId ? packById(packId) : undefined;
      if (!workspaceId || !pack) {
        reply.code(400);
        return { error: { code: 'invalid_request',
                          message: 'Auto-recharge event is missing workspace_id or pack_id metadata.' } };
      }
      const r = await applyPaymentEvent(event.id, 'stripe', workspaceId, pack.creditMicros,
        { pack: pack.id, provider: 'stripe', auto_recharge: true },
        typeof obj.id === 'string' ? obj.id : null);
      return { received: true, applied: r.applied, auto_recharge: true };
    }

    // ---- money back out --------------------------------------------------
    // A refund returns the customer's money; without this the credit would stay
    // and they would keep the product too.
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const isDispute = event.type === 'charge.dispute.created';
      const paymentRef = isDispute
        ? (typeof obj.payment_intent === 'string' ? obj.payment_intent : null)
        : (typeof obj.payment_intent === 'string' ? obj.payment_intent : null);
      if (!paymentRef) return { received: true, ignored: 'no payment_intent on event' };

      // Stripe amounts are in the currency's smallest unit; ours are micro-USD.
      const cents = isDispute ? (obj.amount ?? 0) : (obj.amount_refunded ?? 0);
      const r = await reverseCredit({
        eventId: event.id,
        provider: 'stripe',
        paymentReference: paymentRef,
        amountMicros: cents * 10_000,
        reason: isDispute ? 'dispute' : 'refund',
        detail: { chargeId: obj.id ?? null },
      });
      return { received: true, reversed: r.applied,
               ...(r.applied ? {} : { note: 'no matching credit for this payment' }) };
    }

    return { received: true, ignored: event.type };
  });
}
