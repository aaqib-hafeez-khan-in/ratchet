// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Reports exactly what is and is not configured for payments, and — when the
 * setup is complete — proves it end to end by creating a real Checkout Session.
 *
 *   npx tsx scripts/check-stripe.ts
 *
 * Prints no secret values.
 */
import { config } from '../src/lib/config.js';
import { stripeSelected, stripeConfigured, stripeIsTestKey, stripeSetupGap,
         startCheckout, CREDIT_PACKS, StripeError } from '../src/domain/billing.js';

const mask = (v: string) => v ? `${v.slice(0, 8)}…${v.length} chars` : '(not set)';
const tick = (ok: boolean) => (ok ? '✓' : '✗');

console.log('\nRatchet — payment configuration\n');
console.log(`  BILLING_PROVIDER       ${config.billing.provider}`);
console.log(`  STRIPE_SECRET_KEY      ${mask(config.billing.stripeSecretKey)}`);
console.log(`  STRIPE_WEBHOOK_SECRET  ${mask(config.billing.stripeWebhookSecret)}`);
console.log('');
console.log(`  ${tick(stripeSelected())} Stripe selected and a key is present`);
console.log(`  ${tick(stripeConfigured())} Webhook secret present (required before checkout opens)`);

if (stripeSelected()) {
  console.log(`  ${tick(true)} Key mode: ${stripeIsTestKey() ? 'TEST — no real money moves' : 'LIVE — real charges'}`);
}

const gap = stripeSetupGap();
if (gap) {
  console.log(`\n  Checkout is DISABLED. Missing: ${gap}`);
  console.log('  Selling a payment that cannot be confirmed would leave a customer');
  console.log('  charged and uncredited, so this is a deliberate refusal.\n');
  if (gap === 'STRIPE_WEBHOOK_SECRET') {
    console.log('  Get one for local development with:');
    console.log('    stripe listen --forward-to localhost:8787/v1/billing/webhook/stripe');
    console.log('  then copy the printed whsec_… value into .env and restart.\n');
  }
  process.exit(1);
}

if (!stripeSelected()) {
  console.log('\n  Running the built-in test adapter. No card is charged.\n');
  process.exit(0);
}

console.log('\n  Verifying against the Stripe API…');
try {
  const s = await startCheckout('ws_config_check', CREDIT_PACKS[0]!);
  console.log(`  ${tick(true)} Checkout Session created: ${s.sessionId}`);
  console.log(`  ${tick(true)} Hosted URL: ${new URL(s.url!).origin}/…`);
  console.log(`\n  Payments are ready${s.testMode ? ' (test mode)' : ' (LIVE)'}.`);
  console.log('  Credit is applied only when the signed webhook arrives — never on');
  console.log('  the browser returning to the success URL.\n');
} catch (err) {
  if (err instanceof StripeError) {
    console.log(`  ${tick(false)} Stripe rejected the request: ${err.message}`);
    console.log(`     status ${err.status}${err.stripeCode ? `, code ${err.stripeCode}` : ''}\n`);
  } else {
    console.log(`  ${tick(false)} ${(err as Error).message}\n`);
  }
  process.exit(1);
}
