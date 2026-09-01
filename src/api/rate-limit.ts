/**
 * One place that decides how many requests a caller gets per minute.
 *
 * This exists because it was once decided in three places. The global limiter
 * derived the number from the caller's plan, while `/v1/effects/begin` and the
 * MCP endpoint each hardcoded 600. The result was a limit that contradicted the
 * pricing page in both directions at the same time: a customer paying for
 * 3,000/min was silently capped at 600 on the one endpoint that matters, and a
 * free workspace entitled to 120 was handed 600 on the most expensive route to
 * serve.
 *
 * A route may still be *stricter* than the plan — signup, OAuth, and reconcile
 * all are, deliberately. What a route must never do is invent its own number for
 * the metered path and quietly diverge from what was sold.
 */
import type { FastifyRequest } from 'fastify';
import { config } from '../lib/config.js';
import { cachedPlanLimit } from '../domain/auth.js';
import { PLANS } from '../domain/plans.js';

/** The public, non-secret prefix of whichever API key a request presents. */
export function keyPrefixOf(req: { headers: Record<string, unknown> }): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer rk_')) {
    const m = /^Bearer rk_(?:live|test)_([a-z0-9]{12})_/.exec(h);
    if (m) return m[1]!;
  }
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string') {
    const m = /^rk_(?:live|test)_([a-z0-9]{12})_/.exec(alt);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Requests per minute for this caller: the override when set, otherwise the
 * plan's published allowance, otherwise the unauthenticated default.
 */
export function planRateLimitMax(req: FastifyRequest): number {
  if (config.rateLimitOverride !== null) return config.rateLimitOverride;
  const prefix = keyPrefixOf(req);
  if (!prefix) return config.rateLimitPerMinute;
  return cachedPlanLimit(prefix) ?? PLANS.free.rateLimitPerMinute;
}

/** Limit per API key where one is presented, so tenants behind one NAT are independent. */
export function rateLimitKey(req: FastifyRequest): string {
  const prefix = keyPrefixOf(req);
  return prefix ? `key:${prefix}` : `ip:${req.ip}`;
}

/** Route-level config for any metered route that should track the caller's plan. */
export const planRateLimit = { max: planRateLimitMax, timeWindow: '1 minute' } as const;

/**
 * A route that is deliberately stricter than the plan — signup, OAuth, feedback.
 *
 * Use this rather than a bare `{ max: n }`. A hardcoded number ignores
 * RATE_LIMIT_OVERRIDE, and because the limiter store is Postgres-backed by
 * default the bucket then survives the process: a route capped at ten a minute
 * cannot be exercised more than ten times by any test suite, ever, and the
 * eleventh run of the file fails for reasons that have nothing to do with the
 * change being tested. That is how three feedback tests started returning 429
 * before they had sent a single request.
 *
 * The override is refused in production by assertProductionSafety, so this is
 * strict everywhere it matters.
 */
export const stricterThan = (max: number, timeWindow = '1 minute') => ({
  max: () => config.rateLimitOverride ?? max,
  timeWindow,
} as const);
