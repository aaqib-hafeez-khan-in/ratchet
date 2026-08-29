import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, keyWithScopes, closePool, getPool } from '../helpers.js';

const { beginEffect, reportEffect, getEffect, lookupEffect, listEffects, cancelEffect,
        resolveEffect } = await import('../../src/domain/effects.js');
const { authenticate, requireScope } = await import('../../src/domain/auth.js');

let a: Awaited<ReturnType<typeof freshWorkspace>>;
let b: Awaited<ReturnType<typeof freshWorkspace>>;

before(async () => { a = await freshWorkspace(); b = await freshWorkspace(); });
after(async () => { await closePool(); });

const beginIn = (ws: typeof a, key: string) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'email.send', idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0,
});

describe('tenant isolation', () => {
  test('the same idempotency key in two workspaces is two independent effects', async () => {
    const ea = await beginIn(a, 'shared-key');
    const eb = await beginIn(b, 'shared-key');
    assert.equal(ea.decision, 'execute');
    assert.equal(eb.decision, 'execute', 'workspace B must not be blocked by workspace A');
    assert.notEqual(ea.effectId, eb.effectId);
  });

  test('workspace B cannot read workspace A effects', async () => {
    const ea = await beginIn(a, 'private-1');
    assert.ok(await getEffect(getPool(), a.workspaceId, ea.effectId));
    assert.equal(await getEffect(getPool(), b.workspaceId, ea.effectId), null);
    assert.equal(await lookupEffect(getPool(), b.workspaceId, 'email.send', 'private-1'), null);
    const listed = await listEffects(getPool(), b.workspaceId, {});
    assert.equal(listed.some((e) => e.effectId === ea.effectId), false);
  });

  test('workspace B cannot report on a workspace A lease even with the real token', async () => {
    const ea = await beginIn(a, 'private-2');
    await assert.rejects(
      () => reportEffect({
        workspaceId: b.workspaceId, apiKeyId: b.key.id, apiKeyPrefix: b.key.prefix,
        effectId: ea.effectId, leaseToken: ea.leaseToken!, outcome: 'succeeded', result: {},
      }),
      (e: any) => e.code === 'not_found',
      'a cross-tenant report must not leak that the effect exists',
    );
  });

  test('workspace B cannot cancel or resolve a workspace A effect', async () => {
    const ea = await beginIn(a, 'private-3');
    await assert.rejects(
      () => cancelEffect({ workspaceId: b.workspaceId, effectId: ea.effectId, actor: 'b' }),
      (e: any) => e.code === 'not_found');
    await assert.rejects(
      () => resolveEffect({ workspaceId: b.workspaceId, effectId: ea.effectId,
        actor: 'b', outcome: 'succeeded' }),
      (e: any) => e.code === 'not_found');
  });

  test('policies and budgets do not cross workspaces', async () => {
    const { upsertPolicy, getPolicy } = await import('../../src/domain/policy.js');
    await upsertPolicy(getPool(), a.workspaceId, { effectType: 'x.y', mode: 'deny' });
    assert.equal((await getPolicy(getPool(), a.workspaceId, 'x.y')).mode, 'deny');
    const pb = await getPolicy(getPool(), b.workspaceId, 'x.y');
    assert.equal(pb.mode, 'allow');
    assert.equal(pb.isDefault, true);
  });
});

describe('API key authentication', () => {
  test('a valid key authenticates to its own workspace only', async () => {
    const ctx = await authenticate(a.key.plaintext);
    assert.equal(ctx.workspaceId, a.workspaceId);
  });

  test('malformed, truncated, and forged keys are rejected', async () => {
    const forged = `rk_test_${a.key.prefix}_${'A'.repeat(32)}`;
    for (const bad of ['', 'nonsense', 'rk_test_short_x', a.key.plaintext.slice(0, -4), forged]) {
      await assert.rejects(() => authenticate(bad), (e: any) => e.code === 'unauthorized',
        `must reject: ${bad.slice(0, 24)}`);
    }
  });

  test('a revoked key stops working immediately', async () => {
    const k = await keyWithScopes(a.workspaceId, ['effects:read']);
    await authenticate(k.plaintext);
    await getPool().query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [k.id]);
    await assert.rejects(() => authenticate(k.plaintext), (e: any) => e.code === 'unauthorized');
  });

  test('a suspended workspace cannot authenticate', async () => {
    const ws = await freshWorkspace(false);
    await getPool().query(`UPDATE workspaces SET status='suspended' WHERE id=$1`, [ws.workspaceId]);
    await assert.rejects(() => authenticate(ws.key.plaintext), (e: any) => e.code === 'forbidden');
  });

  test('the plaintext secret is never stored', async () => {
    const { rows } = await getPool().query(
      'SELECT secret_hash, prefix FROM api_keys WHERE id = $1', [a.key.id]);
    const stored = rows[0].secret_hash.toString('hex');
    assert.equal(rows[0].secret_hash.length, 32, 'only a 32-byte digest is kept');
    assert.equal(stored.includes(a.key.plaintext.split('_').pop()!), false);
    const dump = JSON.stringify(rows[0]);
    assert.equal(dump.includes(a.key.plaintext), false);
  });

  test('scopes are enforced, and a narrow key cannot widen itself', async () => {
    const k = await keyWithScopes(a.workspaceId, ['effects:read']);
    const ctx = await authenticate(k.plaintext);
    assert.deepEqual(ctx.scopes, ['effects:read']);
    assert.doesNotThrow(() => requireScope(ctx, 'effects:read'));
    for (const s of ['effects:begin', 'effects:admin', 'policies:write'] as const) {
      assert.throws(() => requireScope(ctx, s), (e: any) => e.code === 'forbidden');
    }
  });
});
