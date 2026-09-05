// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, expireLease, getPool } from '../helpers.js';

const { beginEffect, reportEffect, resolveEffect, cancelEffect, getEffect } =
  await import('../../src/domain/effects.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { sweepExpiredLeases, drainExpiredLeases } = await import('../../src/worker/reaper.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;

function begin(overrides: Record<string, any> = {}) {
  return beginEffect({
    workspaceId: ws.workspaceId,
    apiKeyId: ws.key.id,
    apiKeyPrefix: ws.key.prefix,
    keyDailyBudgetMicros: null,
    effectType: 'email.send',
    idempotencyKey: 'k1',
    payload: { to: 'a@b.com' },
    estimatedCostMicros: 0,
    ...overrides,
  });
}

before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

describe('effect state machine', () => {
  test('first caller gets execute with a lease; a second gets in_flight', async () => {
    const a = await begin({ idempotencyKey: 'inflight-1' });
    assert.equal(a.decision, 'execute');
    assert.ok(a.leaseToken);
    assert.equal(a.attempt, 1);

    const b = await begin({ idempotencyKey: 'inflight-1' });
    assert.equal(b.decision, 'in_flight');
    assert.equal(b.effectId, a.effectId, 'both callers must see one effect');
    assert.equal(b.leaseToken, undefined, 'a waiting caller must never receive a lease');
    assert.ok((b.retryAfterSeconds ?? 0) > 0);
  });

  test('a succeeded effect replays its recorded result forever', async () => {
    const a = await begin({ idempotencyKey: 'dup-1' });
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded',
      result: { messageId: 'msg_1' },
    });
    for (let i = 0; i < 3; i++) {
      const dup = await begin({ idempotencyKey: 'dup-1' });
      assert.equal(dup.decision, 'duplicate');
      assert.deepEqual(dup.result, { messageId: 'msg_1' });
      assert.equal(dup.leaseToken, undefined);
    }
  });

  test('reusing a key with a different payload is refused', async () => {
    await begin({ idempotencyKey: 'fp-1', payload: { to: 'a@b.com' } });
    await assert.rejects(
      () => begin({ idempotencyKey: 'fp-1', payload: { to: 'evil@x.com' } }),
      (e: any) => e.code === 'idempotency_key_reuse',
    );
  });

  test('key order in the payload does not count as a different payload', async () => {
    const a = await begin({ idempotencyKey: 'fp-2', payload: { x: 1, y: 2 } });
    const b = await begin({ idempotencyKey: 'fp-2', payload: { y: 2, x: 1 } });
    assert.equal(b.effectId, a.effectId);
    assert.equal(b.decision, 'in_flight');
  });

  test('a clean failure permits a fresh attempt', async () => {
    const a = await begin({ idempotencyKey: 'fail-1' });
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'failed',
      failureReason: 'smtp rejected the recipient',
    });
    const b = await begin({ idempotencyKey: 'fail-1' });
    assert.equal(b.decision, 'execute');
    assert.equal(b.attempt, 2);
    assert.notEqual(b.leaseToken, a.leaseToken, 'each attempt gets a new fencing token');
  });

  test('the attempt ceiling eventually denies further tries', async () => {
    await upsertPolicy(getPool(), ws.workspaceId, { effectType: 'capped', maxAttempts: 2 });
    let last;
    for (let i = 0; i < 2; i++) {
      const r = await begin({ effectType: 'capped', idempotencyKey: 'cap-1' });
      assert.equal(r.decision, 'execute');
      await reportEffect({
        workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
        effectId: r.effectId, leaseToken: r.leaseToken!, outcome: 'failed', failureReason: 'x',
      });
      last = r;
    }
    const denied = await begin({ effectType: 'capped', idempotencyKey: 'cap-1' });
    assert.equal(denied.decision, 'denied');
    assert.match(denied.reason!, /Attempt limit/);
    assert.equal(last!.attempt, 2);
  });
});

describe('the indeterminate path', () => {
  test('an expired lease becomes indeterminate and blocks by default', async () => {
    const a = await begin({ idempotencyKey: 'ind-1' });
    await expireLease(a.effectId);

    const b = await begin({ idempotencyKey: 'ind-1' });
    assert.equal(b.decision, 'blocked');
    assert.equal(b.state, 'indeterminate');
    assert.equal(b.leaseToken, undefined, 'a blocked caller must never receive a lease');
    assert.equal(b.priorAttempt?.onIndeterminate, 'block');
  });

  test('policy on_indeterminate=retry grants a new attempt', async () => {
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'idem.vendor', onIndeterminate: 'retry', maxAttempts: 5 });
    const a = await begin({ effectType: 'idem.vendor', idempotencyKey: 'ind-2' });
    await expireLease(a.effectId);
    const b = await begin({ effectType: 'idem.vendor', idempotencyKey: 'ind-2' });
    assert.equal(b.decision, 'execute');
    assert.equal(b.attempt, 2);
    assert.equal(b.priorAttempt?.state, 'indeterminate');
  });

  test('policy on_indeterminate=probe blocks until explicitly resolved', async () => {
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'probe.type', onIndeterminate: 'probe' });
    const a = await begin({ effectType: 'probe.type', idempotencyKey: 'ind-3' });
    await expireLease(a.effectId);

    const blocked = await begin({ effectType: 'probe.type', idempotencyKey: 'ind-3' });
    assert.equal(blocked.decision, 'blocked');
    assert.match(blocked.reason!, /[Vv]erify/);

    // The operator checks the vendor and records what actually happened.
    await resolveEffect({
      workspaceId: ws.workspaceId, effectId: a.effectId, actor: 'test',
      outcome: 'succeeded', evidence: 'vendor API shows charge ch_1', result: { charge: 'ch_1' },
    });
    const after = await begin({ effectType: 'probe.type', idempotencyKey: 'ind-3' });
    assert.equal(after.decision, 'duplicate');
    assert.deepEqual(after.result, { charge: 'ch_1' });
  });

  test('the worker reaper produces the same transition as the inline path', async () => {
    const a = await begin({ idempotencyKey: 'reap-1' });
    await expireLease(a.effectId);
    // drain, not one sweep: sweepExpiredLeases takes a batch of 50 ordered by
    // expiry, so in a database holding more than that this effect — the newest —
    // falls outside the batch and the assertion below reads 'pending'. The
    // single sweep happened to be enough only while the database was nearly
    // empty, which is a property of the test run, not of the reaper.
    const swept = await drainExpiredLeases();
    assert.ok(swept >= 1);
    const e = await getEffect(getPool(), ws.workspaceId, a.effectId);
    assert.equal(e?.state, 'indeterminate');
    assert.equal(e?.estimatedCostMicros, 0, 'the reaper must release the budget reservation');
  });
});

describe('lease fencing', () => {
  test('a superseded lease token cannot overwrite a newer attempt', async () => {
    const a = await begin({ effectType: 'idem.vendor', idempotencyKey: 'fence-1' });
    await expireLease(a.effectId);
    const b = await begin({ effectType: 'idem.vendor', idempotencyKey: 'fence-1' });
    assert.equal(b.decision, 'execute');

    // The stalled first worker wakes up and tries to report.
    await assert.rejects(
      () => reportEffect({
        workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
        effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded',
        result: { stale: true },
      }),
      (e: any) => e.code === 'lease_lost',
      'a stale token must be rejected, not silently accepted',
    );

    // The current holder still reports normally.
    const ok = await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: b.effectId, leaseToken: b.leaseToken!, outcome: 'succeeded', result: { fresh: true },
    });
    assert.equal(ok.state, 'succeeded');
    const e = await getEffect(getPool(), ws.workspaceId, a.effectId);
    assert.deepEqual(e?.result, { fresh: true });
  });

  test('reporting twice on a settled effect is refused', async () => {
    const a = await begin({ idempotencyKey: 'double-report' });
    const args = {
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded' as const,
      result: { n: 1 },
    };
    await reportEffect(args);
    await assert.rejects(() => reportEffect(args), (e: any) => e.code === 'lease_lost');
  });
});

describe('approval gating', () => {
  test('require_approval withholds the lease until an operator decides', async () => {
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'wire.transfer', mode: 'require_approval' });
    const a = await begin({ effectType: 'wire.transfer', idempotencyKey: 'appr-1' });
    assert.equal(a.decision, 'approval_required');
    assert.equal(a.leaseToken, undefined);

    const again = await begin({ effectType: 'wire.transfer', idempotencyKey: 'appr-1' });
    assert.equal(again.decision, 'approval_required');

    const { decideApproval } = await import('../../src/domain/effects.js');
    await decideApproval({ workspaceId: ws.workspaceId, effectId: a.effectId,
      actor: 'console:test', approve: true });

    const after = await begin({ effectType: 'wire.transfer', idempotencyKey: 'appr-1' });
    assert.equal(after.decision, 'execute');
    assert.ok(after.leaseToken);
  });

  test('a rejected approval denies the effect permanently', async () => {
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'wire.transfer', mode: 'require_approval' });
    const a = await begin({ effectType: 'wire.transfer', idempotencyKey: 'appr-2' });
    const { decideApproval } = await import('../../src/domain/effects.js');
    await decideApproval({ workspaceId: ws.workspaceId, effectId: a.effectId,
      actor: 'console:test', approve: false, note: 'not authorised' });

    const after = await begin({ effectType: 'wire.transfer', idempotencyKey: 'appr-2' });
    assert.equal(after.decision, 'denied');
    assert.equal(after.leaseToken, undefined);
  });

  test('policy mode=deny refuses without ever granting a lease', async () => {
    await upsertPolicy(getPool(), ws.workspaceId, { effectType: 'forbidden.op', mode: 'deny' });
    const a = await begin({ effectType: 'forbidden.op', idempotencyKey: 'deny-1' });
    assert.equal(a.decision, 'denied');
    assert.equal(a.leaseToken, undefined);
    const b = await begin({ effectType: 'forbidden.op', idempotencyKey: 'deny-1' });
    assert.equal(b.decision, 'denied');
  });
});

describe('cancellation', () => {
  test('a leased effect cannot be cancelled out from under its holder', async () => {
    const a = await begin({ idempotencyKey: 'cancel-1' });
    await assert.rejects(
      () => cancelEffect({ workspaceId: ws.workspaceId, effectId: a.effectId, actor: 'test' }),
      (e: any) => e.code === 'invalid_state',
    );
  });

  test('a succeeded effect cannot be cancelled', async () => {
    const a = await begin({ idempotencyKey: 'cancel-2' });
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded', result: {},
    });
    await assert.rejects(
      () => cancelEffect({ workspaceId: ws.workspaceId, effectId: a.effectId, actor: 'test' }),
      (e: any) => e.code === 'invalid_state',
    );
  });

  test('an indeterminate effect can be cancelled and then stays denied', async () => {
    const a = await begin({ idempotencyKey: 'cancel-3' });
    await expireLease(a.effectId);
    await drainExpiredLeases();
    await cancelEffect({ workspaceId: ws.workspaceId, effectId: a.effectId,
      actor: 'test', reason: 'abandoned' });
    const b = await begin({ idempotencyKey: 'cancel-3' });
    assert.equal(b.decision, 'denied');
  });
});
