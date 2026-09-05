// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { candidates, claimRecharge, settle, disable } from '../domain/auto-recharge.js';
import { chargeSavedCard } from '../domain/billing.js';
import { config } from '../lib/config.js';

/**
 * The only loop in this worker that spends somebody's money.
 *
 * It runs here, and not in the request path, for three reasons that are all the
 * same reason: a network call to Stripe must never be inside the transaction
 * that gates an effect. It would add a round trip to every begin, hold a
 * workspace row lock across the internet, and — worst — a transaction that
 * rolled back after the charge succeeded would take money for credit it never
 * granted.
 *
 * Credit is NOT granted here either. The charge produces a `payment_intent.
 * succeeded` webhook, and the signed webhook grants the credit through exactly
 * the same idempotent path a human checkout uses. Two ways to create money
 * would be one too many.
 */
export async function runRecharges(): Promise<number> {
  // Nothing to do unless a real provider is configured. The test adapter has no
  // saved cards to charge, and pretending otherwise would exercise a path that
  // does not exist in production.
  if (config.billing.provider !== 'stripe') return 0;

  const workspaces = await candidates();
  let charged = 0;

  for (const workspaceId of workspaces) {
    // Claims exactly one attempt, or nothing. The unique index decides.
    const claim = await claimRecharge(workspaceId);
    if (!claim) continue;

    try {
      const res = await chargeSavedCard({
        workspaceId,
        customerId: claim.customerId,
        pack: claim.pack,
        // The row id, which already exists and is unique by index. A retry of
        // this request reaches Stripe with the same key and returns the first
        // charge rather than making a second.
        idempotencyKey: claim.row.id,
      });

      if (res.status === 'succeeded' || res.status === 'processing') {
        await settle(claim.row.id, { ok: true, paymentIntentId: res.paymentIntentId });
        charged++;
        continue;
      }

      // Anything else — `requires_action` above all — means a card that needs a
      // human to authenticate it. There is no human. Saying so is the only
      // honest outcome.
      await settle(claim.row.id, { ok: false, reason: `payment_intent status ${res.status}` });
      await disable(workspaceId,
        `The card needs authentication that cannot be completed automatically `
        + `(status: ${res.status}). Top up once by hand to re-enable.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await settle(claim.row.id, { ok: false, reason });
      // A decline is not transient. Retrying it is how a card gets locked and
      // the customer receives a fraud alert with our name on it.
      await disable(workspaceId,
        `Automatic top-up was declined and has been switched off: ${reason}`);
    }
  }
  return charged;
}
