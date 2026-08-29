import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

// Exercise the Stripe webhook route as a configured live provider would, using
// a known secret. No network call is made: the route's job is to verify a
// signature and apply credit exactly once, and that is what is tested here.
const WEBHOOK_SECRET = 'whsec_integration_test_secret';
process.env.BILLING_PROVIDER = 'stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_integration_placeholder';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { freshWorkspace, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { listLedger, getBilling } = await import('../../src/domain/metering.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let ws: Awaited<ReturnType<typeof freshWorkspace>>;

before(async () => {
  ws = await freshWorkspace(false);
  app = await buildApp({ logger: false });
  await app.ready();
});
after(async () => { await app.close(); await closePool(); });

const sign = (payload: string, t: number, secret = WEBHOOK_SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

function event(id: string, workspaceId: string, packId = 'pack_10') {
  return JSON.stringify({
    id, object: 'event', type: 'checkout.session.completed',
    data: { object: {
      id: `cs_test_${id}`, object: 'checkout.session', payment_status: 'paid',
      metadata: { workspace_id: workspaceId, pack_id: packId },
    } },
  });
}

const deliver = (body: string, sig: string) => app.inject({
  method: 'POST', url: '/v1/billing/webhook/stripe',
  headers: { 'content-type': 'application/json', 'stripe-signature': sig },
  payload: body,
});

describe('Stripe webhook: crediting', () => {
  test('a validly signed event credits the workspace exactly once', async () => {
    const body = event('evt_credit_once', ws.workspaceId);
    const sig = sign(body, Math.floor(Date.now() / 1000));

    const first = await deliver(body, sig);
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.payload).applied, true);

    const billing = await getBilling(getPool(), ws.workspaceId);
    assert.equal(billing!.creditMicros, 10_000_000, '$10 pack must credit $10');

    // Stripe retries on any non-2xx and can redeliver even after a 200.
    for (let i = 0; i < 3; i++) {
      const again = await deliver(body, sign(body, Math.floor(Date.now() / 1000)));
      assert.equal(again.statusCode, 200, 'a redelivery must still be accepted');
      assert.equal(JSON.parse(again.payload).applied, false,
        'a redelivered event must not credit twice');
    }

    const after = await getBilling(getPool(), ws.workspaceId);
    assert.equal(after!.creditMicros, 10_000_000, 'balance must not move on replay');

    const ledger = await listLedger(getPool(), ws.workspaceId, 50);
    const topups = ledger.filter((e) => e.kind === 'topup');
    assert.equal(topups.length, 1, 'exactly one ledger row for one payment');
    assert.equal(topups[0]!.deltaMicros, 10_000_000);
  });

  test('a distinct event does credit again', async () => {
    const body = event('evt_second_payment', ws.workspaceId, 'pack_50');
    const res = await deliver(body, sign(body, Math.floor(Date.now() / 1000)));
    assert.equal(JSON.parse(res.payload).applied, true);
    const billing = await getBilling(getPool(), ws.workspaceId);
    assert.equal(billing!.creditMicros, 60_000_000, '$10 + $50');
  });
});

describe('Stripe webhook: forgery and replay', () => {
  const now = () => Math.floor(Date.now() / 1000);

  test('a tampered body is refused', async () => {
    const body = event('evt_tamper', ws.workspaceId);
    const sig = sign(body, now());
    const res = await deliver(body.replace('pack_10', 'pack_200'), sig);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.payload).error.code, 'invalid_signature');
  });

  test('a signature from the wrong secret is refused', async () => {
    const body = event('evt_wrongsecret', ws.workspaceId);
    const res = await deliver(body, sign(body, now(), 'whsec_attacker'));
    assert.equal(res.statusCode, 400);
  });

  test('a stale signature is refused, so a captured payload cannot be replayed later', async () => {
    const body = event('evt_stale', ws.workspaceId);
    const res = await deliver(body, sign(body, now() - 3600));
    assert.equal(res.statusCode, 400);
  });

  test('a missing or malformed signature header is refused', async () => {
    const body = event('evt_nosig', ws.workspaceId);
    for (const sig of ['', 'garbage', `t=${now()}`, 'v1=deadbeef']) {
      const res = await deliver(body, sig);
      assert.equal(res.statusCode, 400, `must reject header: "${sig}"`);
    }
  });

  test('no refused delivery moved the balance', async () => {
    const billing = await getBilling(getPool(), ws.workspaceId);
    assert.equal(billing!.creditMicros, 60_000_000,
      'forged and stale deliveries must never credit');
  });

  test('an event without our metadata is refused rather than credited blindly', async () => {
    const body = JSON.stringify({
      id: 'evt_nometa', object: 'event', type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', payment_status: 'paid', metadata: {} } },
    });
    const res = await deliver(body, sign(body, now()));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error.message, /workspace_id|pack_id/);
  });

  test('an unrelated event type is acknowledged but ignored', async () => {
    const body = JSON.stringify({
      id: 'evt_other', object: 'event', type: 'payment_intent.created', data: { object: {} } });
    const res = await deliver(body, sign(body, now()));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).ignored, 'payment_intent.created');
  });
});

describe('with a live provider configured', () => {
  test('the local test-settlement endpoint cannot mint credit', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/billing/test/settle',
      headers: { authorization: `Bearer ${ws.key.plaintext}`, 'content-type': 'application/json' },
      payload: { session_id: `cs_test_${ws.workspaceId}_pack_10_1`, pack_id: 'pack_10' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.payload).error.code, 'billing_unavailable');
  });
});
