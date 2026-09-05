// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * The rate limit a caller actually gets must be the one the pricing page sells.
 *
 * This regression is specific: `/v1/effects/begin` and the MCP endpoint each
 * hardcoded `max: 600`, ignoring the plan. A Scale customer entitled to 3,000
 * was capped at 600 on the only route that meters, and a free workspace
 * entitled to 120 was given 600 on the most expensive route to serve. The
 * global limiter was correct the whole time, which is why nothing caught it.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../src/api/app.js';
import { planRateLimitMax } from '../../src/api/rate-limit.js';
import { PLANS } from '../../src/domain/plans.js';
import { config } from '../../src/lib/config.js';
import { closePool } from '../helpers.js';

const SRC = join(import.meta.dirname, '../../src');

describe('rate limits track the plan that was sold', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => { app = await buildApp({ logger: false }); await app.ready(); });
  after(async () => { await app.close(); await closePool(); });

  test('no metered route hardcodes a request ceiling', () => {
    for (const f of ['api/routes/effects.ts', 'mcp/http.ts']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      assert.doesNotMatch(src, /rateLimit:\s*\{\s*max:\s*\d/,
        `${f} hardcodes a rate limit instead of deriving it from the plan`);
    }
  });

  /**
   * The suite sets RATE_LIMIT_OVERRIDE so tests can move volume. That override
   * legitimately outranks the plan, so any assertion about plan-derived numbers
   * has to clear it first — otherwise this file would only ever be asserting
   * that the override works.
   */
  const withoutOverride = <T>(fn: () => T): T => {
    const prev = process.env.RATE_LIMIT_OVERRIDE;
    delete process.env.RATE_LIMIT_OVERRIDE;
    try { return fn(); } finally {
      if (prev !== undefined) process.env.RATE_LIMIT_OVERRIDE = prev;
    }
  };

  test('an unauthenticated caller gets the unauthenticated default', () => {
    const req = { headers: {}, ip: '203.0.113.9' } as never;
    assert.equal(withoutOverride(() => planRateLimitMax(req)), config.rateLimitPerMinute);
  });

  test('an unrecognised key falls back to the free allowance, never higher', () => {
    // A key whose prefix is not in the plan cache must not be handed a paid
    // ceiling — that would make an invalid key cheaper to abuse than a real one.
    const req = { headers: { authorization: 'Bearer rk_live_zzzzzzzzzzzz_nope' },
                  ip: '203.0.113.9' } as never;
    assert.equal(withoutOverride(() => planRateLimitMax(req)), PLANS.free.rateLimitPerMinute);
  });

  test('the override applies to the metered route, not just the global limiter', async () => {
    // Without this, a benchmark or load test silently measures 429 latency.
    const prev = process.env.RATE_LIMIT_OVERRIDE;
    process.env.RATE_LIMIT_OVERRIDE = '1000000';
    try {
      const req = { headers: { authorization: 'Bearer rk_live_zzzzzzzzzzzz_nope' },
                    ip: '203.0.113.9' } as never;
      assert.equal(planRateLimitMax(req), 1_000_000);
    } finally {
      if (prev === undefined) delete process.env.RATE_LIMIT_OVERRIDE;
      else process.env.RATE_LIMIT_OVERRIDE = prev;
    }
  });

  test('every plan the pricing page lists has a usable limit', () => {
    for (const p of Object.values(PLANS)) {
      assert.ok(p.rateLimitPerMinute > 0, `${p.id} has no rate limit`);
    }
    // The ordering customers pay for: more expensive is never more restricted.
    const tiers = Object.values(PLANS).map((p) => p.rateLimitPerMinute);
    assert.deepEqual([...tiers].sort((a, b) => a - b), tiers,
      'plans are defined out of order, or a paid plan is throttled below a cheaper one');
  });
});
