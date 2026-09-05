// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * The path that turns a paid subscription into an active plan.
 *
 * This was the untested half of billing. The existing webhook tests cover
 * one-off credit packs; the SUBSCRIPTION path had no coverage at all — and it is
 * the one that matters for a $29/month plan.
 *
 * It is also easy to get wrong in a way that fails silently. A subscription
 * checkout emits `checkout.session.completed`, and the handler deliberately
 * ignores it: `mode === 'subscription'` returns early, because the plan is
 * granted by `customer.subscription.*` instead. So an endpoint subscribed only
 * to `checkout.session.completed` would return 200 to Stripe, take the money,
 * and never grant anything.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const WEBHOOK_SECRET = 'whsec_subscription_test_secret';
process.env.BILLING_PROVIDER = 'stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_subscription_placeholder';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { freshWorkspace, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const sign = (payload: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')}`;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;
const evtId = (n: string) => `evt_${RUN}_${n}_${++seq}`;

function subEvent(id: string, type: string, workspaceId: string, opts: {
  planId?: string; status?: string; subId?: string;
} = {}) {
  return JSON.stringify({
    id, object: 'event', type,
    data: { object: {
      id: opts.subId ?? `sub_${id}`, object: 'subscription',
      status: opts.status ?? 'active',
      customer: `cus_${RUN}`,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      metadata: { workspace_id: workspaceId, plan_id: opts.planId ?? 'pro' },
    } },
  });
}

const deliver = (body: string) => app.inject({
  method: 'POST', url: '/v1/billing/webhook/stripe',
  headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
  payload: body,
});

const planOf = async (workspaceId: string) => (await getPool().query(
  'SELECT plan FROM workspaces WHERE id = $1', [workspaceId])).rows[0].plan;

describe('a paid subscription grants the plan', () => {
  test('customer.subscription.created moves a workspace onto Pro', async () => {
    const ws = await freshWorkspace(false);
    assert.equal(await planOf(ws.workspaceId), 'free', 'starts on free');

    const r = await deliver(subEvent(evtId('created'), 'customer.subscription.created',
      ws.workspaceId, { planId: 'pro' }));
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.payload).applied, true);
    assert.equal(await planOf(ws.workspaceId), 'pro', 'the money bought something');
  });

  test('the plan carries its real entitlements, not just a label', async () => {
    // A plan column that changed while the limits did not would be the worst
    // kind of half-working: the customer paid and sees "Pro" everywhere.
    const ws = await freshWorkspace(false);
    await deliver(subEvent(evtId('ent'), 'customer.subscription.created',
      ws.workspaceId, { planId: 'scale' }));
    const key = { authorization: `Bearer ${ws.key.plaintext}` };
    const w = JSON.parse((await app.inject({ url: '/v1/workspace', headers: key })).payload);
    assert.equal(w.plan.id, 'scale');
    assert.ok(w.plan.included_effects >= 250000, 'entitlements must follow the plan');
    assert.ok(w.plan.rate_limit_per_minute >= 3000);
  });

  test('the same event twice grants once', async () => {
    const ws = await freshWorkspace(false);
    const body = subEvent(evtId('dup'), 'customer.subscription.created', ws.workspaceId);
    const a = await deliver(body);
    const b = await deliver(body);
    assert.equal(JSON.parse(a.payload).applied, true);
    assert.equal(JSON.parse(b.payload).applied, false, 'a replayed event must not re-apply');
    assert.equal(await planOf(ws.workspaceId), 'pro');
  });

  test('cancelling returns the workspace to free', async () => {
    const ws = await freshWorkspace(false);
    await deliver(subEvent(evtId('c1'), 'customer.subscription.created', ws.workspaceId));
    assert.equal(await planOf(ws.workspaceId), 'pro');

    await deliver(subEvent(evtId('c2'), 'customer.subscription.deleted', ws.workspaceId,
      { status: 'canceled' }));
    assert.equal(await planOf(ws.workspaceId), 'free', 'a cancelled plan must not keep paying out');
  });

  test('a subscription checkout.session.completed grants nothing by itself', async () => {
    // The exact silent failure: an endpoint subscribed ONLY to
    // checkout.session.completed returns 200, takes the money, grants nothing.
    const ws = await freshWorkspace(false);
    const body = JSON.stringify({
      id: evtId('cs'), object: 'event', type: 'checkout.session.completed',
      data: { object: { id: `cs_${RUN}`, object: 'checkout.session', mode: 'subscription',
                        payment_status: 'paid',
                        metadata: { workspace_id: ws.workspaceId, plan_id: 'pro' } } },
    });
    const r = await deliver(body);
    assert.equal(r.statusCode, 200, 'Stripe is told 200 so it stops retrying');
    assert.equal(await planOf(ws.workspaceId), 'free',
      'and the plan is NOT granted here — customer.subscription.* does that');
  });

  test('a subscription without workspace_id is refused, not guessed', async () => {
    const body = JSON.stringify({
      id: evtId('nows'), object: 'event', type: 'customer.subscription.created',
      data: { object: { id: 'sub_x', object: 'subscription', status: 'active', metadata: {} } },
    });
    const r = await deliver(body);
    assert.equal(r.statusCode, 200);
    assert.match(JSON.stringify(JSON.parse(r.payload)), /ignored/);
  });

  test('past_due does not silently keep full entitlements', async () => {
    const ws = await freshWorkspace(false);
    await deliver(subEvent(evtId('p1'), 'customer.subscription.created', ws.workspaceId));
    const r = await deliver(subEvent(evtId('p2'), 'customer.subscription.updated',
      ws.workspaceId, { status: 'past_due' }));
    assert.equal(r.statusCode, 200);
    const { rows } = await getPool().query(
      'SELECT plan, subscription_status FROM workspaces WHERE id = $1', [ws.workspaceId]);
    assert.equal(rows[0].subscription_status, 'past_due',
      'a failing card must be visible in the record');
  });
});
