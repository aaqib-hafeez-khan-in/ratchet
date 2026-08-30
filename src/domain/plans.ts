/**
 * Ratchet's own pricing. One meter: a *gated effect* — the first successful
 * begin() for a given (workspace, effect_type, idempotency_key).
 *
 * Three plans. Free to evaluate, Pro for production, Scale for volume.
 *
 * Scale deliberately collects LESS at a given volume than Pro-plus-overage
 * would: at 250k effects that is $249 against $366. It exists because a
 * variable bill is what triggers a procurement review, and predictable revenue
 * that renews is worth more than a larger invoice that churns.
 *
 * There is no enterprise tier, and adding one would be dishonest today. What
 * enterprises actually buy at that level is an SLA, SSO, and a support
 * commitment — none of which a single-region deployment with no failover and
 * one maintainer can honour. See docs/handoff/KNOWN_LIMITATIONS.md. Selling it
 * anyway is how a service acquires a customer it then fails.
 *
 * Everything else is free: duplicate suppression, in-flight checks, retries of
 * the same key, outcome reports, reads, policy changes, and webhooks. Callers
 * are never penalised for the retry behaviour the product exists to absorb.
 */

export type PlanId = 'free' | 'pro' | 'scale';

export interface Plan {
  id: PlanId;
  name: string;
  /** Recurring price in micro-USD per month. */
  monthlyPriceMicros: number;
  /** Gated effects included each calendar month. */
  includedEffects: number;
  /** Overage price per gated effect, drawn from prepaid credit. */
  overageMicrosPerEffect: number;
  /** Sustained request ceiling for the whole workspace. */
  rateLimitPerMinute: number;
  /** Days that completed effect records and their results are retained. */
  maxRetentionDays: number;
  maxApiKeys: number;
  maxWebhookEndpoints: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPriceMicros: 0,
    // Enough to integrate, exercise every policy mode, and run a hobby agent.
    // Deliberately NOT enough to run a business process — that is where the
    // line belongs. Retries and duplicates are free, so a test suite hammering
    // one key costs a single unit.
    includedEffects: 1_000,
    // Free is a hard stop: no automatic overage without prepaid credit.
    overageMicrosPerEffect: 1_500,
    // 120/min, not 60. The monthly volume cap is what bounds a free workspace;
    // a tight per-minute limit only throttles the burst someone makes while
    // integrating, which is precisely when the product must feel good.
    rateLimitPerMinute: 120,
    maxRetentionDays: 7,
    // Three, not two: a default key plus separate dev and prod keys is a
    // legitimate free-tier need, and keys cost nothing to serve.
    maxApiKeys: 3,
    maxWebhookEndpoints: 1,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyPriceMicros: 29_000_000,
    includedEffects: 25_000,
    // $1.50 per 1,000. Close to the included rate ($1.16/1,000) on purpose:
    // overage is the same product at roughly the same price, neither a penalty
    // nor a discount.
    overageMicrosPerEffect: 1_500,
    rateLimitPerMinute: 600,
    maxRetentionDays: 30,
    maxApiKeys: 20,
    maxWebhookEndpoints: 5,
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    monthlyPriceMicros: 249_000_000,
    includedEffects: 250_000,
    // $1.00 per 1,000 — a real volume rate. Every limit below is one the code
    // actually enforces; nothing here is a promise the service cannot keep.
    overageMicrosPerEffect: 1_000,
    rateLimitPerMinute: 3_000,
    maxRetentionDays: 90,
    maxApiKeys: 100,
    maxWebhookEndpoints: 25,
  },
};

export function planFor(id: string): Plan {
  return PLANS[id as PlanId] ?? PLANS.free;
}

/**
 * Above this monthly volume, list pricing stops applying and we talk. Published
 * so the boundary is visible rather than discovered on an invoice.
 */
export const CUSTOM_PRICING_THRESHOLD = 250_000;

export const microsToUsd = (micros: number): string => (micros / 1_000_000).toFixed(6);
export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);
