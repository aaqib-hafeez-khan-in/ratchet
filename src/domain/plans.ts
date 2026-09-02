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
  /**
   * What this plan can do, as distinct from how much of it.
   *
   * Every other field here is a quantity. These are the first capability gates,
   * and the line they are drawn along matters: **nothing that keeps an agent
   * from doing damage is behind one of them.** At-most-once, every policy mode,
   * indeterminate handling, surge containment, run budgets, recall, approvals,
   * webhooks and the audit trail are on the free plan and stay there. Selling
   * safety by the tier would make the product worse for the people least able
   * to pay, while its whole argument is that the safe thing should be the easy
   * thing.
   *
   * What is gated is evidence, recovery and scale — the things a team needs to
   * run this in production and prove it to somebody else, rather than the
   * things that stop the bad outcome.
   */
  capabilities: PlanCapabilities;
}

export interface PlanCapabilities {
  /**
   * Reversible effect groups: unwinding a partially-completed unit of work.
   * A free workspace still gets at-most-once on every individual step; what it
   * does not get is the machinery for undoing four steps when the fifth failed.
   */
  reversibleGroups: boolean;
  /**
   * Reading and verifying the signed receipt chain.
   *
   * Receipts are WRITTEN for every workspace on every plan — they are part of
   * the audit chain and skipping them for some workspaces would break it. This
   * gates reading them back and verifying the chain, which is what an auditor
   * wants and what a hobby project does not.
   */
  signedReceipts: boolean;
  /**
   * Reconciliation: finding real-world actions that bypassed the gate entirely.
   * Expensive to run and only meaningful once there is a system of record to
   * compare against, which is a scale problem by definition.
   */
  reconciliation: boolean;
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
    // Four, not three, because signup now issues TWO keys of its own: a
    // full-scope operator key and a gate-only agent key. Keys the service mints
    // for you must not eat the allowance you were sold, so this preserves the
    // same two user-created keys the free plan has always allowed.
    maxApiKeys: 4,
    maxWebhookEndpoints: 1,
    // Everything that prevents damage. Nothing that proves it to a third party.
    capabilities: {
      reversibleGroups: false,
      signedReceipts: false,
      reconciliation: false,
    },
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
    // The two things a team running this in production needs and a hobby
    // project does not: a way to undo a half-finished unit of work, and
    // evidence of each decision that can be checked without trusting us.
    capabilities: {
      reversibleGroups: true,
      signedReceipts: true,
      reconciliation: false,
    },
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
    capabilities: {
      reversibleGroups: true,
      signedReceipts: true,
      reconciliation: true,
    },
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
