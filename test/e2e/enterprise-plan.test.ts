// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * A tier that is sold rather than bought.
 *
 * The property that matters is not what Enterprise grants — it grants no
 * capability Scale lacks, on purpose, because the fraud controls are safety and
 * safety is never the thing withheld. What matters is that nobody can put
 * themselves on it. It has no list price, so a checkout for it would be a
 * subscription at zero per month with ten times Scale's limits.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { PLANS, SELF_SERVE_PLAN_IDS } = await import('../../src/domain/plans.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const signup = async () => JSON.parse((await app.inject({
  method: 'POST', url: '/v1/workspaces',
  headers: { 'content-type': 'application/json' },
  payload: { name: 'ent', email: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test` },
})).payload);

const subscribe = (key: string, planId: string) => app.inject({
  method: 'POST', url: '/v1/billing/subscribe',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: { plan_id: planId },
});

describe('nobody can buy it', () => {
  test('checkout refuses it, and says why', async () => {
    const ws = await signup();
    const r = await subscribe(ws.api_key, 'enterprise');
    assert.notEqual(r.statusCode, 200, 'a checkout session for a priceless plan must not exist');
    assert.equal(r.payload.includes('checkout.stripe.com'), false);
  });

  test('the refusal is structural, not a list of plan ids in a route', async () => {
    // The domain call is what has to hold: a route schema is a copy of this fact
    // and copies drift. This reaches startSubscription directly.
    const { startSubscription } = await import('../../src/domain/billing.js');
    const ws = await signup();
    await assert.rejects(
      () => startSubscription(ws.workspace_id, 'enterprise'),
      (e: Error) => /not sold through checkout/.test(e.message));
  });

  test('the published contract does not offer it for sale', async () => {
    const doc = JSON.parse((await app.inject({ method: 'GET', url: '/openapi.json' })).payload);
    const body = doc.paths['/v1/billing/subscribe'].post.requestBody
      .content['application/json'].schema;
    assert.deepEqual(body.properties.plan_id.enum, [...SELF_SERVE_PLAN_IDS]);
    assert.equal(body.properties.plan_id.enum.includes('enterprise'), false);
    assert.deepEqual([...SELF_SERVE_PLAN_IDS], ['pro', 'scale'],
      'if a new sellable tier appears, this test should be the thing that notices');
  });

  test('the free plan is not purchasable either', async () => {
    const ws = await signup();
    const r = await subscribe(ws.api_key, 'free');
    assert.equal(r.statusCode, 400, 'there is nothing to buy');
  });
});

describe('what it is, and is not', () => {
  test('it withholds no control that a paid plan has', () => {
    for (const [cap, on] of Object.entries(PLANS.scale.capabilities)) {
      assert.equal(PLANS.enterprise.capabilities[cap as keyof typeof PLANS.scale.capabilities], on,
        `enterprise differs from scale on "${cap}" — this tier is limits and terms, not safety`);
    }
  });

  test('every limit is at least as generous as Scale', () => {
    const e = PLANS.enterprise, s = PLANS.scale;
    for (const k of ['includedEffects', 'rateLimitPerMinute', 'maxRetentionDays',
                     'maxApiKeys', 'maxWebhookEndpoints'] as const) {
      assert.ok(e[k] > s[k], `${k}: ${e[k]} is not more than Scale's ${s[k]}`);
    }
    assert.ok(e.overageMicrosPerEffect < s.overageMicrosPerEffect,
      'a tier that charged more per effect than the one beneath it is a penalty for growing');
  });

  test('retention stays inside what the database will accept', () => {
    // effect_policies.retention_days is CHECK (BETWEEN 1 AND 400). A plan
    // offering more would be a limit the service cannot actually honour.
    assert.ok(PLANS.enterprise.maxRetentionDays <= 400);
  });

  test('the pricing page is told not to show a price', async () => {
    const plans = JSON.parse((await app.inject({
      method: 'GET', url: '/v1/billing/plans' })).payload).plans;
    const ent = plans.find((p: { id: string }) => p.id === 'enterprise');
    assert.ok(ent, 'the tier must be listed — a sold plan nobody can see is not sold');
    assert.equal(ent.self_serve, false);
    assert.equal(ent.monthly_price_micros, 0,
      'zero here means "no list price", which is only safe because self_serve is false');
    for (const p of plans.filter((x: { id: string }) => x.id !== 'enterprise')) {
      assert.equal(p.self_serve, true);
    }
  });
});

describe('the pricing copy cannot drift from the plan', () => {
  /**
   * The cards are generated from PLANS; the prose beside them is typed out. That
   * is the arrangement this page's own comment warns about — "a tier table that
   * drifts from the code is the one kind of marketing copy that is also a broken
   * promise" — so the prose is checked against the same object the guards use.
   */
  const html = readFileSync(new URL('../../web/pricing.html', import.meta.url), 'utf8');
  const e = PLANS.enterprise;

  test('every figure in the Enterprise section is the enforced one', () => {
    const section = html.slice(html.indexOf('id="enterprise"'), html.indexOf('Billing status'));
    const expected: [string, string][] = [
      ['included effects', e.includedEffects.toLocaleString('en-US')],
      ['overage per 1,000', `$${(e.overageMicrosPerEffect / 1000).toFixed(2)}`],
      ['rate limit', e.rateLimitPerMinute.toLocaleString('en-US')],
      ['retention days', String(e.maxRetentionDays)],
      ['api keys', String(e.maxApiKeys)],
      ['webhook endpoints', String(e.maxWebhookEndpoints)],
    ];
    for (const [what, value] of expected) {
      assert.ok(section.includes(value),
        `the copy does not mention ${what} as "${value}" — the prose has drifted from PLANS`);
    }
  });

  test('it compares itself to Scale honestly', () => {
    const section = html.slice(html.indexOf('id="enterprise"'), html.indexOf('Billing status'));
    assert.ok(section.includes(String(PLANS.scale.maxRetentionDays)),
      'the copy claims a comparison with Scale, so Scale\'s number has to be Scale\'s number');
    assert.ok(e.overageMicrosPerEffect < PLANS.scale.overageMicrosPerEffect,
      'the copy says the rate is below Scale\'s; it must actually be');
  });

  test('the page says the controls are not gated, because they are not', () => {
    assert.match(html, /withholds no control/i);
    assert.match(html, /ships on every plan/i);
    // And the claim is true, which the capability test above already asserts.
    assert.deepEqual(e.capabilities, PLANS.scale.capabilities);
  });
});

describe('a workspace can actually be put on it', () => {
  test('the database accepts the plan', async () => {
    const ws = await signup();
    await getPool().query('UPDATE workspaces SET plan = $2 WHERE id = $1',
      [ws.workspace_id, 'enterprise']);
    const { rows } = await getPool().query<{ plan: string }>(
      'SELECT plan FROM workspaces WHERE id = $1', [ws.workspace_id]);
    assert.equal(rows[0]!.plan, 'enterprise',
      'the CHECK constraint has to know about the tier or the script cannot grant it');
  });

  test('and the limits it then gets are the enterprise ones', async () => {
    const ws = await signup();
    await getPool().query('UPDATE workspaces SET plan = $2 WHERE id = $1',
      [ws.workspace_id, 'enterprise']);
    const view = JSON.parse((await app.inject({
      method: 'GET', url: '/v1/workspace',
      headers: { authorization: `Bearer ${ws.api_key}` },
    })).payload);
    assert.equal(view.plan.id, 'enterprise');
    // The limits the caller is actually told about must be the tier's own, not
    // a default that quietly appears when a plan id is unrecognised.
    assert.equal(view.plan.included_effects, PLANS.enterprise.includedEffects);
    assert.equal(view.plan.overage_micros_per_effect, PLANS.enterprise.overageMicrosPerEffect);
  });
});
