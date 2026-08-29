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
      () => startCheckout('ws_1', packById('pack_10')!),
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
      () => settleTestCheckout('ws_1', 'cs_test_ws_1_pack_10_1', packById('pack_10')!),
      (e: Error) => e instanceof BillingUnavailable,
      'local settlement must not be able to mint credit when Stripe is wired',
    );
  });
});
