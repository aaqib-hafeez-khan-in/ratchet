import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { wsOf, actorOf } from '../plugins/auth.js';
import { audit } from '../../domain/audit.js';
import { CREDIT_PACKS, packById, startCheckout, settleTestCheckout,
         verifyStripeSignature, applyPaymentEvent, stripeConfigured,
         BillingUnavailable } from '../../domain/billing.js';
import { PLANS } from '../../domain/plans.js';
import { config } from '../../lib/config.js';
import { errorResponses } from '../schemas.js';

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
    })),
    credit_packs: CREDIT_PACKS.map((c) => ({
      id: c.id, label: c.label,
      price_micros: c.priceMicros, credit_micros: c.creditMicros,
    })),
    provider: {
      name: config.billing.provider,
      live: stripeConfigured(),
      test_mode: !stripeConfigured(),
      note: stripeConfigured()
        ? 'A live payment provider is configured.'
        : 'Running the built-in test adapter: no card is charged and no external request is made.',
    },
  }));

  app.post('/billing/checkout', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Billing'], operationId: 'startCheckout',
      summary: 'Begin a prepaid credit purchase',
      body: {
        type: 'object', required: ['pack_id'], additionalProperties: false,
        properties: { pack_id: { type: 'string', enum: CREDIT_PACKS.map((p) => p.id) } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const pack = packById((req.body as { pack_id: string }).pack_id);
    if (!pack) throw errors.invalid('Unknown credit pack.');
    try {
      const s = await startCheckout(wsOf(req), pack);
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
        throw new (await import('../../lib/errors.js')).ApiError(
          503, 'billing_unavailable', err.message);
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
        throw new (await import('../../lib/errors.js')).ApiError(
          503, 'billing_unavailable', err.message);
      }
      throw err;
    }
  });

  // Signature-verified provider callback. Unauthenticated by design — the HMAC
  // over the raw body IS the authentication.
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
    if (event.type !== 'checkout.session.completed') return { received: true, ignored: event.type };

    const session = event.data?.object ?? {};
    const workspaceId = session.metadata?.workspace_id;
    const packId = session.metadata?.pack_id;
    const pack = packId ? packById(packId) : undefined;
    if (!workspaceId || !pack) {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'Event is missing workspace_id or pack_id metadata.' } };
    }
    const r = await applyPaymentEvent(event.id, 'stripe', workspaceId, pack.creditMicros,
      { pack: pack.id, provider: 'stripe' });
    return { received: true, applied: r.applied };
  });
}
