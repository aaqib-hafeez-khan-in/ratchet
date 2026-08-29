/**
 * Seeds a workspace with realistic traffic: a completed effect, a duplicate,
 * a crashed attempt left indeterminate, and one awaiting approval. Used to
 * exercise the console against real state rather than fixtures.
 *
 *   npx tsx scripts/seed.ts [workspaceId]
 */
import { getPool, closePool } from '../src/db/pool.js';
import { createWorkspace, createApiKey, SCOPES } from '../src/domain/auth.js';
import { upsertPolicy } from '../src/domain/policy.js';
import { beginEffect, reportEffect } from '../src/domain/effects.js';
import { sweepExpiredLeases } from '../src/worker/reaper.js';

const arg = process.argv[2];
let workspaceId: string;
let keyId: string;
let keyPrefix: string;

if (arg) {
  workspaceId = arg;
  const k = await createApiKey(getPool(), workspaceId, 'seed-driver', [...SCOPES], null);
  keyId = k.id; keyPrefix = k.prefix;
  console.log(`seeding existing workspace ${workspaceId}`);
} else {
  const ws = await createWorkspace('Seed Workspace', 'seed@example.test');
  workspaceId = ws.workspaceId; keyId = ws.key.id; keyPrefix = ws.key.prefix;
  console.log(`workspace ${workspaceId}`);
  console.log(`api key   ${ws.key.plaintext}`);
}

const begin = (o: Record<string, any>) => beginEffect({
  workspaceId, apiKeyId: keyId, apiKeyPrefix: keyPrefix, keyDailyBudgetMicros: null,
  payload: o.payload ?? {}, estimatedCostMicros: 0, ...o,
});

// 1. A completed effect with a replayable result.
const a = await begin({
  effectType: 'email.send', idempotencyKey: 'welcome:u_9001',
  payload: { to: 'sam@example.test', template: 'welcome' },
  estimatedCostMicros: 800, agentId: 'onboarding-agent', runId: 'run_a',
});
await reportEffect({
  workspaceId, apiKeyId: keyId, apiKeyPrefix: keyPrefix,
  effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded',
  result: { message_id: 'msg_77' }, actualCostMicros: 780,
});

// 2. A second agent asks about the same work and is told to stand down.
const dup = await begin({
  effectType: 'email.send', idempotencyKey: 'welcome:u_9001',
  payload: { to: 'sam@example.test', template: 'welcome' },
  estimatedCostMicros: 800, agentId: 'retry-agent', runId: 'run_a',
});
console.log(`duplicate suppression -> ${dup.decision}`);

// 3. An agent that took a lease and died. Left for the reaper.
await begin({
  effectType: 'payment.charge', idempotencyKey: 'invoice:2026-08:acct_88123',
  payload: { cents: 4200 }, estimatedCostMicros: 42000,
  agentId: 'billing-agent', runId: 'run_b', leaseSeconds: 5,
});

// 4. An effect type that requires a human decision.
await upsertPolicy(getPool(), workspaceId,
  { effectType: 'wire.transfer', mode: 'require_approval', onIndeterminate: 'probe' });
const appr = await begin({
  effectType: 'wire.transfer', idempotencyKey: 'payout:vendor_12:2026-08',
  payload: { usd: 2500 }, estimatedCostMicros: 2_500_000,
  agentId: 'finance-agent', runId: 'run_c',
});
console.log(`approval gate -> ${appr.decision}`);

// 5. A clean failure, which is safe to retry.
const f = await begin({
  effectType: 'http.post', idempotencyKey: 'webhook:order_551',
  payload: { url: 'https://partner.example/orders' }, agentId: 'sync-agent', runId: 'run_d',
});
await reportEffect({
  workspaceId, apiKeyId: keyId, apiKeyPrefix: keyPrefix,
  effectId: f.effectId, leaseToken: f.leaseToken!, outcome: 'failed',
  failureReason: 'partner rejected the payload schema',
});

// Let the crashed lease lapse, then sweep it exactly as the worker would.
await new Promise((r) => setTimeout(r, 6000));
console.log(`reaped ${await sweepExpiredLeases()} expired lease(s)`);

await closePool();
console.log('seeded');
