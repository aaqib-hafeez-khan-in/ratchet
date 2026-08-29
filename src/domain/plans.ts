/**
 * Ratchet's own pricing. One meter: a *gated effect* — the first successful
 * begin() for a given (workspace, effect_type, idempotency_key).
 *
 * Everything else is free: duplicate suppression, in-flight checks, retries of
 * the same key, outcome reports, reads, policy changes, and webhooks. Callers
 * are never penalised for the retry behaviour the product exists to absorb.
 */

export type PlanId = 'free' | 'starter' | 'scale';

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
    includedEffects: 5_000,
    overageMicrosPerEffect: 200,
    rateLimitPerMinute: 120,
    maxRetentionDays: 7,
    maxApiKeys: 3,
    maxWebhookEndpoints: 1,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyPriceMicros: 19_000_000,
    includedEffects: 100_000,
    overageMicrosPerEffect: 150,
    rateLimitPerMinute: 600,
    maxRetentionDays: 30,
    maxApiKeys: 20,
    maxWebhookEndpoints: 5,
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    monthlyPriceMicros: 99_000_000,
    includedEffects: 1_000_000,
    overageMicrosPerEffect: 100,
    rateLimitPerMinute: 3_000,
    maxRetentionDays: 90,
    maxApiKeys: 100,
    maxWebhookEndpoints: 25,
  },
};

export function planFor(id: string): Plan {
  return PLANS[id as PlanId] ?? PLANS.free;
}

export const microsToUsd = (micros: number): string => (micros / 1_000_000).toFixed(6);
export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);
