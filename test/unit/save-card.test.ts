// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Keeping a customer's card is a decision they make, not one we make for them.
 *
 * `setup_future_usage` is what allows an unattended charge later. Setting it by
 * default would mean every buyer's card is retained because it was convenient
 * for us — the kind of thing somebody discovers from a statement. These tests
 * exist so that turning it on by accident fails loudly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { buildCheckoutParams, CREDIT_PACKS } = await import('../../src/domain/billing.js');
const PACK = CREDIT_PACKS[0]!;

describe('saving the card is opt-in', () => {
  test('a plain purchase keeps nothing', () => {
    const p = buildCheckoutParams('ws_1', PACK);
    assert.equal(p['payment_intent_data[setup_future_usage]'], undefined,
      'a purchase that did not ask must not retain the card');
    assert.equal(p.customer_creation, undefined);
    assert.equal(p.customer, undefined);
  });

  test('opting in sets off_session and creates a customer to hold it', () => {
    const p = buildCheckoutParams('ws_1', PACK, { saveCard: true });
    assert.equal(p['payment_intent_data[setup_future_usage]'], 'off_session');
    assert.equal(p.customer_creation, 'always',
      'without a Customer, Stripe has nowhere to attach a reusable payment method');
  });

  /**
   * Two Stripe Customers for one workspace would split its payment methods
   * between them, and automatic top-up would charge whichever it happened to
   * find. A workspace that already has one must keep using it.
   */
  test('an existing customer is reused, never duplicated', () => {
    const p = buildCheckoutParams('ws_1', PACK,
      { saveCard: true, existingCustomerId: 'cus_existing' });
    assert.equal(p.customer, 'cus_existing');
    assert.equal(p.customer_creation, undefined,
      'asking Stripe to create a customer while naming one is a contradiction');
    assert.equal(p['payment_intent_data[setup_future_usage]'], 'off_session');
  });

  test('the metadata a payment needs is present either way', () => {
    for (const opts of [{}, { saveCard: true }]) {
      const p = buildCheckoutParams('ws_meta', PACK, opts);
      assert.equal(p['metadata[workspace_id]'], 'ws_meta');
      assert.equal(p['metadata[pack_id]'], PACK.id);
      assert.equal(p['payment_intent_data[metadata][workspace_id]'], 'ws_meta');
    }
  });
});
