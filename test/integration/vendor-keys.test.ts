/**
 * Vendor-enforced idempotency.
 *
 * The attempt scoping is the whole design. Get it wrong in one direction and a
 * caller can double-charge by retrying; wrong in the other and a legitimately
 * retried effect replays the vendor's recorded failure forever and can never
 * succeed. Both are tested here directly.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';
import { vendorIdempotencyKey, VENDOR_PROFILES } from '../../src/domain/vendor-keys.js';

const { beginEffect, reportEffect } = await import('../../src/domain/effects.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const begin = (key: string, vendor?: string) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'payment.charge', idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0, vendor,
});

describe('vendor key derivation', () => {
  test('is deterministic for the same attempt', () => {
    const a = { workspaceId: 'ws_1', effectType: 'payment.charge', idempotencyKey: 'x', attempt: 1 };
    assert.equal(vendorIdempotencyKey(a).key, vendorIdempotencyKey(a).key);
  });

  test('changes with the attempt number', () => {
    const base = { workspaceId: 'ws_1', effectType: 'payment.charge', idempotencyKey: 'x' };
    assert.notEqual(
      vendorIdempotencyKey({ ...base, attempt: 1 }).key,
      vendorIdempotencyKey({ ...base, attempt: 2 }).key,
      'a retry after failure must get a fresh key or the vendor replays the failure',
    );
  });

  test('does not collide across workspaces or effect types', () => {
    const k = (o: Record<string, unknown>) => vendorIdempotencyKey({
      workspaceId: 'ws_1', effectType: 'payment.charge', idempotencyKey: 'x', attempt: 1, ...o,
    }).key;
    assert.notEqual(k({}), k({ workspaceId: 'ws_2' }));
    assert.notEqual(k({}), k({ effectType: 'email.send' }));
    assert.notEqual(k({}), k({ idempotencyKey: 'y' }));
  });

  test('discloses nothing about its inputs', () => {
    const v = vendorIdempotencyKey({
      workspaceId: 'ws_secret', effectType: 'payment.charge',
      idempotencyKey: 'customer:alice@example.com', attempt: 1,
    });
    for (const leak of ['ws_secret', 'alice', 'example.com', 'payment.charge']) {
      assert.ok(!v.key.includes(leak), `key leaks ${leak}`);
    }
  });

  test('respects each vendor length limit', () => {
    for (const [name, profile] of Object.entries(VENDOR_PROFILES)) {
      const v = vendorIdempotencyKey({
        workspaceId: 'ws_1', effectType: 'payment.charge',
        idempotencyKey: 'x'.repeat(200), attempt: 1, vendor: name,
      });
      assert.ok(v.key.length <= profile.maxLength,
        `${name}: ${v.key.length} exceeds ${profile.maxLength}`);
      assert.ok(v.key.startsWith('rtk_'));
    }
  });

  test('never claims enforcement a vendor does not provide', () => {
    // SendGrid does not deduplicate. Saying it does would be the exact kind of
    // quiet overclaim this product exists to avoid.
    assert.equal(vendorIdempotencyKey({
      workspaceId: 'w', effectType: 'email.send', idempotencyKey: 'x',
      attempt: 1, vendor: 'sendgrid' }).enforced, false);
    assert.equal(vendorIdempotencyKey({
      workspaceId: 'w', effectType: 'payment.charge', idempotencyKey: 'x',
      attempt: 1, vendor: 'stripe' }).enforced, true);
  });

  test('an unknown vendor falls back rather than failing', () => {
    const v = vendorIdempotencyKey({
      workspaceId: 'w', effectType: 'payment.charge', idempotencyKey: 'x',
      attempt: 1, vendor: 'some-vendor-we-have-never-heard-of' });
    assert.equal(v.vendor, 'generic');
    assert.equal(v.enforced, false);
  });
});

describe('vendor key through the gate', () => {
  test('accompanies an execute decision, shaped for the named vendor', async () => {
    const r = await begin(`vk-${Date.now()}`, 'stripe');
    assert.equal(r.decision, 'execute');
    assert.ok(r.vendorKey, 'an authorised caller needs the key to send onward');
    assert.equal(r.vendorKey!.vendor, 'stripe');
    assert.equal(r.vendorKey!.enforced, true);
    assert.match(r.vendorKey!.placement, /Idempotency-Key/);
  });

  test('is NEVER given to a caller who was not authorised', async () => {
    const key = `vk-unauth-${Date.now()}`;
    await begin(key, 'stripe');
    const second = await begin(key, 'stripe');
    assert.notEqual(second.decision, 'execute');
    // Handing the key to a losing caller would let it satisfy the vendor and
    // perform the very duplicate the gate just refused.
    assert.equal(second.vendorKey, undefined,
      'a refused caller must not receive the key that would let the vendor accept it');
  });

  test('a legitimate retry after failure gets a DIFFERENT key', async () => {
    const key = `vk-retry-${Date.now()}`;
    const first = await begin(key, 'stripe');
    assert.equal(first.decision, 'execute');
    const firstKey = first.vendorKey!.key;

    await reportEffect({
      workspaceId: ws.workspaceId, effectId: first.effectId,
      leaseToken: first.leaseToken!, outcome: 'failed', failureReason: 'card declined',
    apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
    });

    const retry = await begin(key, 'stripe');
    assert.equal(retry.decision, 'execute');
    assert.notEqual(retry.vendorKey!.key, firstKey,
      'reusing the key would make the vendor replay the decline forever');
  });
});

/**
 * Cost declaration.
 *
 * A ceiling computed from a field nobody sends is a safety feature that never
 * runs. reserveSpend returns immediately at zero, so an undeclared cost does
 * not under-report — it skips the check entirely.
 */
describe('declared cost', () => {

  test('a configured ceiling with no declared cost warns rather than staying silent', async () => {
    const w = await freshWorkspace();
    await upsertPolicy(getPool(), w.workspaceId, {
      effectType: 'payment.charge', dailyBudgetMicros: 100_000_000,
    });
    const r = await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge',
      idempotencyKey: `warn-${Date.now()}`, payload: {}, estimatedCostMicros: 0,
    });
    assert.equal(r.decision, 'execute');
    assert.ok(r.budgetWarning, 'an inert ceiling must be surfaced, not left silent');
    assert.match(r.budgetWarning!, /never trigger/);
  });

  test('no warning when the cost is declared', async () => {
    const w = await freshWorkspace();
    await upsertPolicy(getPool(), w.workspaceId, {
      effectType: 'payment.charge', dailyBudgetMicros: 100_000_000,
    });
    const r = await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge',
      idempotencyKey: `nowarn-${Date.now()}`, payload: {}, estimatedCostMicros: 5_000_000,
    });
    assert.equal(r.budgetWarning, undefined);
  });

  test('no warning when no ceiling exists — silence should mean nothing is wrong', async () => {
    const w = await freshWorkspace();
    const r = await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'email.send',
      idempotencyKey: `noceil-${Date.now()}`, payload: {}, estimatedCostMicros: 0,
    });
    assert.equal(r.budgetWarning, undefined, 'warning on every call would train people to ignore it');
  });

  test('require_cost refuses an undeclared cost outright', async () => {
    const w = await freshWorkspace();
    await upsertPolicy(getPool(), w.workspaceId, {
      effectType: 'payment.charge', requireCost: true, dailyBudgetMicros: 100_000_000,
    });
    await assert.rejects(
      () => beginEffect({
        workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
        keyDailyBudgetMicros: null, effectType: 'payment.charge',
        idempotencyKey: `req-${Date.now()}`, payload: {}, estimatedCostMicros: 0,
      }),
      (e: { code?: string }) => e.code === 'cost_required',
    );
  });

  test('require_cost still admits a declared cost', async () => {
    const w = await freshWorkspace();
    await upsertPolicy(getPool(), w.workspaceId, {
      effectType: 'payment.charge', requireCost: true,
    });
    const r = await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge',
      idempotencyKey: `reqok-${Date.now()}`, payload: {}, estimatedCostMicros: 1_000_000,
    });
    assert.equal(r.decision, 'execute');
  });
});
