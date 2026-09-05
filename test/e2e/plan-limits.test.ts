// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// A high anonymous limit, so this file measures the PLAN limit and not the
// unauthenticated ceiling.
process.env.RATE_LIMIT_PER_MINUTE = '100000';
// Empty (not deleted) so helpers' `??=` cannot re-enable it.
process.env.RATE_LIMIT_OVERRIDE = '';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace, forgetPlanLimit } = await import('../../src/domain/auth.js');
const { PLANS } = await import('../../src/domain/plans.js');

let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.ready();
});
after(async () => { await app.close(); await closePool(); });

async function workspaceOnPlan(plan: 'free' | 'pro', label: string) {
  const ws = await createWorkspace(label, `${label}@example.test`, false);
  await getPool().query('UPDATE workspaces SET plan = $2 WHERE id = $1', [ws.workspaceId, plan]);
  forgetPlanLimit(ws.key.prefix);
  return ws;
}

const hit = (key: string) =>
  app.inject({ url: '/v1/effects', headers: { authorization: `Bearer ${key}` } });

/** Sends `n` requests and reports how many were accepted. */
async function burst(key: string, n: number) {
  let ok = 0;
  for (let i = 0; i < n; i++) if ((await hit(key)).statusCode === 200) ok++;
  return ok;
}

/**
 * Drive a key until it is refused, and say whether that happened.
 *
 * Windows are fixed to wall-clock boundaries — `Math.floor(now / window) *
 * window` — so a burst that straddles one has its counter reset halfway
 * through and the caller is not throttled at all. The burst takes ~300 ms
 * against a 60 s window, so this happens on roughly one run in two hundred,
 * which is exactly often enough to fail CI occasionally and never fail locally.
 *
 * Sending twice the limit guarantees one side of any single boundary still
 * exceeds it, so the test measures the limiter rather than the clock.
 */
async function driveUntilRefused(key: string, cap: number) {
  for (let i = 0; i < cap; i++) {
    if ((await hit(key)).statusCode === 429) return i + 1;
  }
  return null;
}

describe('rate limits are enforced per plan, not globally', () => {
  test('a free workspace is held to the free plan limit', async () => {
    const ws = await workspaceOnPlan('free', 'rl-free');
    const limit = PLANS.free.rateLimitPerMinute;
    const ok = await burst(ws.key.plaintext, limit + 15);
    assert.equal(ok, limit,
      `free plan publishes ${limit}/min and must enforce exactly that, got ${ok}`);
  });

  test('a higher plan really receives its larger published limit', async () => {
    const ws = await workspaceOnPlan('pro', 'rl-pro');
    const freeLimit = PLANS.free.rateLimitPerMinute;
    // The decisive assertion: a paying workspace must exceed the free ceiling.
    // Before this was enforced, every plan shared one global number.
    const ok = await burst(ws.key.plaintext, freeLimit + 40);
    assert.equal(ok, freeLimit + 40,
      'a Pro workspace must not be throttled at the free limit');
    assert.ok(PLANS.pro.rateLimitPerMinute > freeLimit);
  });

  test('one workspace exhausting its limit does not affect another', async () => {
    const a = await workspaceOnPlan('free', 'rl-iso-a');
    const b = await workspaceOnPlan('free', 'rl-iso-b');

    const at = await driveUntilRefused(a.key.plaintext, PLANS.free.rateLimitPerMinute * 2 + 10);
    assert.ok(at, 'A must be throttleable within twice its limit');
    assert.ok(at > PLANS.free.rateLimitPerMinute,
      `A was refused after ${at} requests, below its published limit of `
      + `${PLANS.free.rateLimitPerMinute}`);

    // The point of the test: B is a different tenant and has spent nothing.
    assert.equal((await hit(b.key.plaintext)).statusCode, 200, 'B must be unaffected');
  });

  test('the published limit and the enforced limit are the same number', async () => {
    // Guards against the pricing table drifting from the limiter again.
    const plans = JSON.parse((await app.inject({ url: '/v1/billing/plans' })).payload);
    for (const p of plans.plans) {
      assert.equal(p.rate_limit_per_minute,
        PLANS[p.id as keyof typeof PLANS].rateLimitPerMinute,
        `${p.id}: published limit must equal the enforced limit`);
    }
  });
});
