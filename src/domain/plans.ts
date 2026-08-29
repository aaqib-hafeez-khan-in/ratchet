/**
 * Ratchet's own pricing. One meter: a *gated effect* — the first successful
 * begin() for a given (workspace, effect_type, idempotency_key).
 *
 * Two plans, not three. Three tiers assert knowledge of three segments; with no
 * usage history there is no evidence for one. Above CUSTOM_PRICING_THRESHOLD
 * the honest answer is a conversation, not a published number for a customer
 * profile nobody has observed yet.
 *
 * Everything else is free: duplicate suppression, in-flight checks, retries of
 * the same key, outcome reports, reads, policy changes, and webhooks. Callers
 * are never penalised for the retry behaviour the product exists to absorb.
 */

export type PlanId = 'free' | 'pro';

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
    rateLimitPerMinute: 60,
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
