// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const WEBHOOK_SECRET = 'whsec_refund_test_secret';
process.env.BILLING_PROVIDER = 'stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_refund_placeholder';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { freshWorkspace, closePool, getPool, setPeriodDecisions } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { getBilling, listLedger } = await import('../../src/domain/metering.js');
const { beginEffect } = await import('../../src/domain/effects.js');
const { PLANS } = await import('../../src/domain/plans.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let ws: Awaited<ReturnType<typeof freshWorkspace>>;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const id = (n: string) => `${n}_${RUN}`;

before(async () => {
  ws = await freshWorkspace(false);
  app = await buildApp({ logger: false });
  await app.ready();
});
after(async () => { await app.close(); await closePool(); });

const sign = (payload: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')}`;

const deliver = (body: string) => app.inject({
  method: 'POST', url: '/v1/billing/webhook/stripe',
  headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
  payload: body,
});

const paid = (evt: string, pi: string, pack = 'pack_25') => JSON.stringify({
  id: evt, object: 'event', type: 'checkout.session.completed',
  data: { object: { id: `cs_${evt}`, payment_intent: pi, payment_status: 'paid',
                    metadata: { workspace_id: ws.workspaceId, pack_id: pack } } },
});

const refunded = (evt: string, pi: string, cents: number) => JSON.stringify({
  id: evt, object: 'event', type: 'charge.refunded',
  data: { object: { id: `ch_${evt}`, payment_intent: pi, amount_refunded: cents } },
});

describe('refunds reverse credit', () => {
  test('a full refund removes exactly what the payment added', async () => {
    const pi = id('pi_full');
    await deliver(paid(id('evt_pay_full'), pi));
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, 25_000_000);

    const res = await deliver(refunded(id('evt_ref_full'), pi, 2500));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).reversed, true);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, 0,
      'a full refund must leave no credit behind');

    // The ledger stays append-only: a compensating entry, not an edited one.
    const ledger = await listLedger(getPool(), ws.workspaceId, 50);
    const topup = ledger.filter((e) => e.kind === 'topup');
    const reversal = ledger.filter((e) => e.kind === 'adjustment' && e.deltaMicros < 0);
    assert.equal(topup.length, 1);
    assert.equal(reversal.length, 1);
    assert.equal(reversal[0]!.deltaMicros, -25_000_000);
    assert.equal((reversal[0]!.detail as any).reason, 'refund');
  });

  test('a replayed refund event does not reverse twice', async () => {
    const pi = id('pi_replay');
    await deliver(paid(id('evt_pay_replay'), pi, 'pack_100'));
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;

    const evt = id('evt_ref_replay');
    const first = await deliver(refunded(evt, pi, 10000));
    assert.equal(JSON.parse(first.payload).reversed, true);
    const afterFirst = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    assert.equal(before - afterFirst, 100_000_000);

    for (let i = 0; i < 3; i++) {
      const again = await deliver(refunded(evt, pi, 10000));
      assert.equal(again.statusCode, 200);
      assert.equal(JSON.parse(again.payload).reversed, false,
        'Stripe redelivers; a replayed refund must not reverse again');
    }
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, afterFirst);
  });

  test('a partial refund reverses only the refunded portion', async () => {
    const pi = id('pi_partial');
    await deliver(paid(id('evt_pay_partial'), pi, 'pack_100'));
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;

    await deliver(refunded(id('evt_ref_partial'), pi, 2500));   // $25 of $100
    const after = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    assert.equal(before - after, 25_000_000);
  });

  test('a reversal cannot exceed what was credited', async () => {
    const pi = id('pi_over');
    await deliver(paid(id('evt_pay_over'), pi));                 // $25 in
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    await deliver(refunded(id('evt_ref_over'), pi, 999_999));    // absurd amount
    const after = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    assert.equal(before - after, 25_000_000,
      'a malformed provider payload must not drain the balance');
  });

  test('a refund for a payment we never credited is acknowledged, not invented', async () => {
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const res = await deliver(refunded(id('evt_ref_unknown'), id('pi_unknown'), 5000));
    assert.equal(res.statusCode, 200, 'Stripe must not be made to retry forever');
    assert.equal(JSON.parse(res.payload).reversed, false);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before);
  });

  test('a dispute reverses the full charge', async () => {
    const pi = id('pi_dispute');
    await deliver(paid(id('evt_pay_dispute'), pi));
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const body = JSON.stringify({
      id: id('evt_dispute'), object: 'event', type: 'charge.dispute.created',
      data: { object: { id: 'ch_d', payment_intent: pi, amount: 2500 } },
    });
    const res = await deliver(body);
    assert.equal(JSON.parse(res.payload).reversed, true);
    assert.equal(before - (await getBilling(getPool(), ws.workspaceId))!.creditMicros, 25_000_000);
  });

  test('spent credit that is refunded leaves a negative balance, and blocks new effects', async () => {
    const w = await freshWorkspace(false);
    const pi = id('pi_spent');
    const body = JSON.stringify({
      id: id('evt_pay_spent'), object: 'event', type: 'checkout.session.completed',
      data: { object: { id: 'cs_s', payment_intent: pi, payment_status: 'paid',
                        metadata: { workspace_id: w.workspaceId, pack_id: 'pack_25' } } },
    });
    await deliver(body);

    // Burn through the included allowance so the next effect draws credit.
    await setPeriodDecisions(w.workspaceId, PLANS.free.includedEffects);
    await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'email.send', idempotencyKey: 'spent-1',
      payload: {}, estimatedCostMicros: 0,
    });

    await deliver(refunded(id('evt_ref_spent'), pi, 2500));
    const after = (await getBilling(getPool(), w.workspaceId))!.creditMicros;
    assert.ok(after < 0,
      'credit already spent and then refunded is genuinely owed; clamping at zero would hide it');

    // And the debt has the correct consequence.
    await assert.rejects(
      () => beginEffect({
        workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
        keyDailyBudgetMicros: null, effectType: 'email.send', idempotencyKey: 'spent-2',
        payload: {}, estimatedCostMicros: 0,
      }),
      (e: any) => e.code === 'insufficient_credit');
  });

  test('an unrelated event type is acknowledged and ignored', async () => {
    const body = JSON.stringify({
      id: id('evt_unrelated'), object: 'event', type: 'invoice.paid', data: { object: {} } });
    const res = await deliver(body);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).ignored, 'invoice.paid');
  });
});
