// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool, expireLease } from '../helpers.js';

const { beginEffect, reportEffect, extendLease } = await import('../../src/domain/effects.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { sweepExpiredLeases } = await import('../../src/worker/reaper.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => {
  ws = await freshWorkspace(false);
  await upsertPolicy(getPool(), ws.workspaceId, { effectType: 'slow.export', leaseSeconds: 600 });
});
after(async () => { await closePool(); });

const begin = (key: string, leaseSeconds?: number) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'slow.export', idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0, ...(leaseSeconds ? { leaseSeconds } : {}),
});

describe('lease heartbeat', () => {
  test('a healthy agent keeps its lease instead of being marked unknown', async () => {
    // Short lease, long job — the situation that previously produced a false
    // `indeterminate` on an agent that was working perfectly well.
    const a = await begin('hb-1', 10);
    const first = a.leaseExpiresAt!;

    const r = await extendLease({
      workspaceId: ws.workspaceId, effectId: a.effectId,
      leaseToken: a.leaseToken!, extendSeconds: 300 });
    assert.ok(new Date(r.leaseExpiresAt) > new Date(first), 'the lease must move forward');

    // The reaper must now leave it alone.
    await sweepExpiredLeases();
    const { rows } = await getPool().query('SELECT state FROM effects WHERE id=$1', [a.effectId]);
    assert.equal(rows[0].state, 'pending');

    // And the report still succeeds.
    const rep = await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded', result: { ok: true } });
    assert.equal(rep.state, 'succeeded');
  });

  test('the lease token is unchanged, so the caller keeps using the one it has', async () => {
    const a = await begin('hb-2', 60);
    await extendLease({ workspaceId: ws.workspaceId, effectId: a.effectId,
      leaseToken: a.leaseToken!, extendSeconds: 120 });
    const { rows } = await getPool().query('SELECT lease_token FROM effects WHERE id=$1', [a.effectId]);
    assert.equal(rows[0].lease_token, a.leaseToken);
  });

  test('an already-expired lease cannot be revived', async () => {
    // The outcome is already recorded as unknown. Extending would erase that,
    // which is exactly the silent-retry this service exists to prevent.
    const a = await begin('hb-3', 30);
    await expireLease(a.effectId);
    await assert.rejects(
      () => extendLease({ workspaceId: ws.workspaceId, effectId: a.effectId,
        leaseToken: a.leaseToken!, extendSeconds: 300 }),
      (e: any) => e.code === 'lease_expired');
  });

  test('a superseded holder cannot extend a lease that moved on', async () => {
    const a = await begin('hb-4', 30);
    await expireLease(a.effectId);
    await sweepExpiredLeases();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'slow.export', leaseSeconds: 600, onIndeterminate: 'retry' });
    const b = await begin('hb-4');
    assert.equal(b.decision, 'execute', 'a second attempt now holds it');

    await assert.rejects(
      () => extendLease({ workspaceId: ws.workspaceId, effectId: a.effectId,
        leaseToken: a.leaseToken!, extendSeconds: 300 }),
      (e: any) => e.code === 'lease_lost',
      'the fencing token must still govern');
  });

  test('a settled effect cannot be extended', async () => {
    const a = await begin('hb-5', 60);
    await reportEffect({ workspaceId: ws.workspaceId, apiKeyId: ws.key.id,
      apiKeyPrefix: ws.key.prefix, effectId: a.effectId, leaseToken: a.leaseToken!,
      outcome: 'succeeded', result: {} });
    await assert.rejects(
      () => extendLease({ workspaceId: ws.workspaceId, effectId: a.effectId,
        leaseToken: a.leaseToken!, extendSeconds: 300 }),
      (e: any) => e.code === 'invalid_state');
  });

  test('an extension is clamped to the policy maximum', async () => {
    await upsertPolicy(getPool(), ws.workspaceId, { effectType: 'capped.op', leaseSeconds: 30 });
    const a = await beginEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'capped.op', idempotencyKey: 'hb-6',
      payload: {}, estimatedCostMicros: 0 });
    const r = await extendLease({ workspaceId: ws.workspaceId, effectId: a.effectId,
      leaseToken: a.leaseToken!, extendSeconds: 3600 });
    const seconds = (new Date(r.leaseExpiresAt).getTime() - Date.now()) / 1000;
    assert.ok(seconds <= 31, `clamped to the 30s policy, got ${seconds.toFixed(0)}s`);
  });

  test('another workspace cannot extend this one’s lease', async () => {
    const other = await freshWorkspace(false);
    const a = await begin('hb-7', 60);
    await assert.rejects(
      () => extendLease({ workspaceId: other.workspaceId, effectId: a.effectId,
        leaseToken: a.leaseToken!, extendSeconds: 120 }),
      (e: any) => e.code === 'not_found');
  });
});
