// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Vendor-enforced idempotency.
 *
 * Ratchet's gate has always been advisory. It protects you from an agent that
 * asks permission, which is not the agent you are afraid of. A misbehaving
 * agent simply does not call, and nothing here can stop it.
 *
 * This closes that hole by moving enforcement to the one party that cannot be
 * bypassed: the vendor. Ratchet derives the idempotency key the vendor itself
 * will deduplicate on. The caller passes it to Stripe, or Square, or whoever.
 * The duplicate is then refused by the VENDOR, not prevented by our good
 * manners, and it is refused whether or not the agent cooperated with us.
 *
 * Composed with a vendor that honours idempotency keys, at-most-once
 * *initiation* becomes at-most-once *execution at that vendor*. That is not a
 * softening of the rule that exactly-once is unachievable: it is unachievable
 * in general, and this is a compositional guarantee that holds only where the
 * vendor supplies the other half. Where it does not, we say so.
 *
 * THE ATTEMPT NUMBER IS THE SUBTLE PART, and getting it wrong would be worse
 * than not doing this at all.
 *
 * A vendor keyed on idempotency replays the RECORDED RESPONSE for a repeated
 * key, including a recorded failure. So:
 *
 *   Same attempt, retried after a timeout  -> same key -> vendor deduplicates.
 *                                             This is the point: the caller
 *                                             cannot double-charge by retrying.
 *
 *   New attempt, after a reported failure  -> new key -> the vendor genuinely
 *                                             tries again. Reusing the key here
 *                                             would replay the old failure
 *                                             forever and the effect could
 *                                             never succeed.
 *
 * So the attempt counter is part of the derivation. An effect that failed and
 * is being legitimately retried gets a fresh vendor key; a caller retrying the
 * same attempt does not.
 *
 * The key is an HMAC under AUTH_SECRET: deterministic for us, opaque to
 * everyone else. It discloses nothing about the workspace, the effect type, or
 * the caller's own idempotency key, all of which may carry customer
 * identifiers.
 */
import { createHmac } from 'node:crypto';
import { config } from '../lib/config.js';
import { normalizeText } from '../lib/ids.js';

/** Per-vendor constraints. A wrong length is silently truncated by some APIs. */
export interface VendorProfile {
  vendor: string;
  /** Where the caller puts it. */
  placement: string;
  maxLength: number;
  /** How long the vendor remembers it. Past this, it stops deduplicating. */
  retention: string;
  /** True only where the vendor actually deduplicates on the key. */
  enforced: boolean;
  note: string;
}

export const VENDOR_PROFILES: Record<string, VendorProfile> = {
  stripe: {
    vendor: 'stripe',
    placement: 'Idempotency-Key header',
    maxLength: 255,
    retention: '24 hours',
    enforced: true,
    note: 'Replays the original response, including errors. Scoped per API key.',
  },
  square: {
    vendor: 'square',
    placement: 'idempotency_key field in the request body',
    maxLength: 192,
    retention: '24 hours on payments',
    enforced: true,
    note: 'Required rather than optional on payment endpoints.',
  },
  adyen: {
    vendor: 'adyen',
    placement: 'Idempotency-Key header',
    maxLength: 64,
    retention: 'about 1 hour',
    enforced: true,
    note: 'Short retention. Do not rely on it for slow retries.',
  },
  paypal: {
    vendor: 'paypal',
    placement: 'PayPal-Request-Id header',
    maxLength: 108,
    retention: 'about 72 hours',
    enforced: true,
    note: 'Applies to order and payment creation.',
  },
  sendgrid: {
    vendor: 'sendgrid',
    placement: 'custom_args, for your own reconciliation',
    maxLength: 100,
    retention: 'not deduplicated',
    enforced: false,
    note: 'SendGrid does NOT deduplicate on this. The gate stays advisory here; '
      + 'the key is only useful for matching sends back to effects afterwards.',
  },
  resend: {
    vendor: 'resend',
    placement: 'Idempotency-Key header (Resend-Idempotency-Key over SMTP)',
    maxLength: 256,
    retention: '24 hours',
    enforced: true,
    note: 'Replays the original response without sending again. Verified against '
      + "Resend's idempotency documentation, 1 September 2026.",
  },
  shopify: {
    vendor: 'shopify',
    placement: 'idempotency key argument or directive on the mutation',
    maxLength: 255,
    retention: 'per endpoint; not universally documented',
    enforced: true,
    note: 'PARTIAL. Accepted on payment, subscription billing, inventory adjustment '
      + 'and refund operations — mandatory on some — and NOT on ordinary writes such '
      + 'as creating a product. Treat as enforced only for those operations.',
  },
  github: {
    vendor: 'github',
    placement: 'no idempotency mechanism; keep the key for reconciliation',
    maxLength: 255,
    retention: 'not deduplicated',
    enforced: false,
    note: 'The REST API documents no idempotency key. Creating an issue, a pull '
      + 'request or a comment twice creates two. Verified 1 September 2026.',
  },
  slack: {
    vendor: 'slack',
    placement: 'no idempotency mechanism; keep the key for reconciliation',
    maxLength: 255,
    retention: 'not deduplicated',
    enforced: false,
    note: 'chat.postMessage documents no idempotency key. A retried post is a second '
      + 'message. Verified 1 September 2026.',
  },
  notion: {
    vendor: 'notion',
    placement: 'no idempotency mechanism; keep the key for reconciliation',
    maxLength: 255,
    retention: 'not deduplicated',
    enforced: false,
    note: 'No idempotency key documented on page or block creation. Verified '
      + '1 September 2026.',
  },
  figma: {
    vendor: 'figma',
    placement: 'no idempotency mechanism; keep the key for reconciliation',
    maxLength: 255,
    retention: 'not deduplicated',
    enforced: false,
    note: 'The REST API documents no idempotency key. Verified 1 September 2026.',
  },
  twilio: {
    vendor: 'twilio',
    placement: 'Idempotency-Key header, where the endpoint supports it',
    maxLength: 128,
    retention: 'varies by endpoint',
    enforced: false,
    note: 'Coverage is partial. Verify for the specific endpoint before relying on it.',
  },
  generic: {
    vendor: 'generic',
    placement: 'whatever the vendor calls its idempotency key',
    maxLength: 255,
    retention: 'unknown',
    enforced: false,
    note: 'If the vendor does deduplicate, this key is safe to use. If it does not, '
      + 'the key is still useful for reconciling their records against yours.',
  },
};

export interface VendorKey {
  key: string;
  vendor: string;
  placement: string;
  enforced: boolean;
  note: string;
}

/**
 * Derive the vendor-facing idempotency key for one attempt at one effect.
 *
 * Stable for a given (workspace, effect type, caller key, attempt) and
 * unpredictable without AUTH_SECRET, so nobody outside can forge a key that
 * collides with a customer's real one.
 */
export function vendorIdempotencyKey(input: {
  workspaceId: string;
  effectType: string;
  idempotencyKey: string;
  attempt: number;
  vendor?: string;
}): VendorKey {
  const profile = VENDOR_PROFILES[(input.vendor ?? 'generic').toLowerCase()]
    ?? VENDOR_PROFILES.generic!;

  // Normalised on the same terms as the effect identity, or two platforms
  // spelling one key differently would derive different vendor keys and the
  // vendor would fail to deduplicate them.
  const material = [
    'rtk.v1',
    input.workspaceId,
    normalizeText(input.effectType),
    normalizeText(input.idempotencyKey),
    String(input.attempt),
  ].join('\u0000');

  const digest = createHmac('sha256', config.authSecret).update(material).digest('base64url');
  // Prefixed so it is recognisable in a vendor dashboard and during reconciliation.
  const full = `rtk_${digest}`;

  return {
    key: full.slice(0, profile.maxLength),
    vendor: profile.vendor,
    placement: profile.placement,
    enforced: profile.enforced,
    note: profile.note,
  };
}
