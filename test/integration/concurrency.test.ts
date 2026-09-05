// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';

const { beginEffect } = await import('../../src/domain/effects.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const begin = (key: string, type = 'email.send', cost = 0) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: type, idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: cost,
});

describe('concurrency', () => {
  test('exactly one of many simultaneous callers may execute', async () => {
    const N = 25;
    const results = await Promise.all(Array.from({ length: N }, () => begin('race-1')));

    const executes = results.filter((r) => r.decision === 'execute');
    assert.equal(executes.length, 1,
      `exactly one caller must be authorised, got ${executes.length}`);

    const others = results.filter((r) => r.decision !== 'execute');
    assert.equal(others.length, N - 1);
    for (const r of others) {
      assert.equal(r.decision, 'in_flight');
      assert.equal(r.leaseToken, undefined, 'a losing caller must never receive a lease');
    }
    // All callers agree on the same effect identity.
    assert.equal(new Set(results.map((r) => r.effectId)).size, 1);
  });

  test('only one effect row exists after a race', async () => {
    await Promise.all(Array.from({ length: 15 }, () => begin('race-2')));
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM effects
        WHERE workspace_id=$1 AND effect_type='email.send' AND idempotency_key='race-2'`,
      [ws.workspaceId]);
    assert.equal(rows[0].n, 1);
  });

  test('a race meters exactly one gated effect, not one per caller', async () => {
    const before = await getPool().query<{ period_decisions: number }>(
      'SELECT period_decisions FROM workspaces WHERE id=$1', [ws.workspaceId]);
    await Promise.all(Array.from({ length: 20 }, () => begin('race-3')));
    const after = await getPool().query<{ period_decisions: number }>(
      'SELECT period_decisions FROM workspaces WHERE id=$1', [ws.workspaceId]);
    assert.equal(after.rows[0]!.period_decisions - before.rows[0]!.period_decisions, 1,
      'callers must not be billed for losing a race');
  });

  test('distinct keys proceed in parallel without blocking each other', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => begin(`parallel-${i}`)));
    assert.equal(results.filter((r) => r.decision === 'execute').length, 10);
    assert.equal(new Set(results.map((r) => r.effectId)).size, 10);
  });

  test('concurrent budget reservations cannot oversubscribe a ceiling', async () => {
    const { upsertPolicy } = await import('../../src/domain/policy.js');
    // Budget allows exactly 5 effects of 1000 micros each today.
    await upsertPolicy(getPool(), ws.workspaceId, {
      effectType: 'budgeted.op', dailyBudgetMicros: 5000,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => begin(`budget-${i}`, 'budgeted.op', 1000)));

    const granted = results.filter(
      (r) => r.status === 'fulfilled' && r.value.decision === 'execute').length;
    const refused = results.filter(
      (r) => r.status === 'rejected' && (r.reason as any).code === 'budget_exceeded').length;

    assert.equal(granted, 5, `budget must admit exactly 5, admitted ${granted}`);
    assert.equal(granted + refused, 20, 'every call must either be granted or refused for budget');

    const { rows } = await getPool().query<{ spent_micros: number }>(
      `SELECT spent_micros FROM spend_windows
        WHERE workspace_id=$1 AND scope='type:budgeted.op' AND day=current_date`,
      [ws.workspaceId]);
    assert.equal(rows[0]!.spent_micros, 5000, 'reserved spend must never exceed the ceiling');
  });
});
