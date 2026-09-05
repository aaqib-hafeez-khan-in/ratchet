// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-to-pass-checks';
process.env.DATABASE_URL = 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet_test';

const { stripeSelected, stripeConfigured, stripeIsTestKey, stripeSetupGap,
        startCheckout, packById, BillingUnavailable } =
  await import('../../src/domain/billing.js');

const saved = {
  provider: process.env.BILLING_PROVIDER,
  key: process.env.STRIPE_SECRET_KEY,
  hook: process.env.STRIPE_WEBHOOK_SECRET,
};

function setEnv(provider?: string, key?: string, hook?: string) {
  if (provider === undefined) delete process.env.BILLING_PROVIDER;
  else process.env.BILLING_PROVIDER = provider;
  if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = key;
  if (hook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = hook;
}

beforeEach(() => setEnv());
afterEach(() => setEnv(saved.provider, saved.key, saved.hook));

describe('payment provider configuration states', () => {
  test('with no provider, the test adapter is active', () => {
    setEnv();
    assert.equal(stripeSelected(), false);
    assert.equal(stripeConfigured(), false);
    assert.equal(stripeSetupGap(), null);
  });

  test('a secret key alone selects Stripe but does NOT enable checkout', () => {
    setEnv('stripe', 'sk_test_abc');
    assert.equal(stripeSelected(), true);
    assert.equal(stripeConfigured(), false,
      'checkout must stay closed until the webhook secret exists');
    assert.equal(stripeSetupGap(), 'STRIPE_WEBHOOK_SECRET');
  });

  test('checkout refuses, with an actionable reason, while the gap remains', async () => {
    setEnv('stripe', 'sk_test_abc');
    await assert.rejects(
      () => startCheckout('ws_1', packById('pack_25')!),
      (err: Error) => {
        assert.ok(err instanceof BillingUnavailable);
        assert.match(err.message, /STRIPE_WEBHOOK_SECRET/);
        // The reason matters: this is a deliberate refusal, not a bug.
        assert.match(err.message, /charged and uncredited/);
        return true;
      },
      'selling a payment we cannot confirm must be refused',
    );
  });

  test('Stripe selected with no key at all names the key as the gap', () => {
    setEnv('stripe');
    assert.equal(stripeSetupGap(), 'STRIPE_SECRET_KEY');
    assert.equal(stripeConfigured(), false);
  });

  test('both halves present enables checkout', () => {
    setEnv('stripe', 'sk_test_abc', 'whsec_abc');
    assert.equal(stripeConfigured(), true);
    assert.equal(stripeSetupGap(), null);
  });

  test('a test key is never reported as live', () => {
    setEnv('stripe', 'sk_test_abc', 'whsec_abc');
    assert.equal(stripeIsTestKey(), true);
    setEnv('stripe', 'sk_live_abc', 'whsec_abc');
    assert.equal(stripeIsTestKey(), false);
  });

  test('the test adapter is disabled once a live provider is configured', async () => {
    setEnv('stripe', 'sk_test_abc', 'whsec_abc');
    const { settleTestCheckout } = await import('../../src/domain/billing.js');
    await assert.rejects(
      () => settleTestCheckout('ws_1', 'cs_test_ws_1_pack_10_1', packById('pack_25')!),
      (e: Error) => e instanceof BillingUnavailable,
      'local settlement must not be able to mint credit when Stripe is wired',
    );
  });
});

describe('checkout session parameters', () => {
  test('metadata the webhook depends on is always present', async () => {
    setEnv('stripe', 'sk_test_abc', 'whsec_abc');
    const { buildCheckoutParams } = await import('../../src/domain/billing.js');
    const p = buildCheckoutParams('ws_meta', packById('pack_25')!);

    // Without these a completed payment cannot be attributed to a workspace,
    // so the money would arrive with nowhere to credit it.
    assert.equal(p['metadata[workspace_id]'], 'ws_meta');
    assert.equal(p['metadata[pack_id]'], 'pack_25');
    assert.equal(p['payment_intent_data[metadata][workspace_id]'], 'ws_meta');
    assert.equal(p.client_reference_id, 'ws_meta');
  });

  test('the amount charged matches the pack, in cents', async () => {
    setEnv('stripe', 'sk_test_abc', 'whsec_abc');
    const { buildCheckoutParams } = await import('../../src/domain/billing.js');
    for (const [id, cents] of [['pack_25', '2500'], ['pack_100', '10000'], ['pack_500', '50000']]) {
      const p = buildCheckoutParams('ws_1', packById(id!)!);
      assert.equal(p['line_items[0][price_data][unit_amount]'], cents,
        `${id} must charge ${cents} cents`);
      assert.equal(p['line_items[0][price_data][currency]'], 'usd');
    }
  });

  test('tax is off unless explicitly enabled', async () => {
    setEnv('stripe', 'sk_test_abc', 'whsec_abc');
    delete process.env.STRIPE_AUTOMATIC_TAX;
    const { buildCheckoutParams } = await import('../../src/domain/billing.js');
    const p = buildCheckoutParams('ws_1', packById('pack_25')!);
    // Enabling tax without a configured origin address makes Stripe reject
    // every checkout, so the default must be off.
    assert.equal('automatic_tax[enabled]' in p, false);
    assert.equal('billing_address_collection' in p, false);
  });

  test('enabling tax also collects the address Stripe needs to compute it', async () => {
    setEnv('stripe', 'sk_test_abc', 'whsec_abc');
    process.env.STRIPE_AUTOMATIC_TAX = 'true';
    const { buildCheckoutParams } = await import('../../src/domain/billing.js');
    const p = buildCheckoutParams('ws_1', packById('pack_25')!);
    assert.equal(p['automatic_tax[enabled]'], 'true');
    assert.equal(p.billing_address_collection, 'required',
      'Stripe cannot determine a jurisdiction without an address');
    // Tax rides on top; the credited face value must not change.
    assert.equal(p['line_items[0][price_data][unit_amount]'], '2500');
    delete process.env.STRIPE_AUTOMATIC_TAX;
  });
});
