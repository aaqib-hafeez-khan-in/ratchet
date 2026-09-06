// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Coverage is a property of the traffic, not of the configuration.
 *
 * Reconciliation exists to find real-world actions that never came through the
 * gate. `reconciliationStatus` reports per effect type — reading
 * `FROM effect_policies`, which is the set of types somebody configured.
 *
 * But `getPolicy` returns DEFAULT_POLICY without inserting a row, so a type can
 * be gated thousands of times and never appear in that table. Those types were
 * therefore absent from the report entirely: not "never reconciled", not
 * "overdue" — absent. And a type nobody thought hard enough about to configure
 * is precisely where an ungated path is most likely to be hiding.
 *
 * The report was blindest exactly where the risk is highest.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';
import { reconciliationStatus, coverage } from '../../src/domain/reconciliation.js';

const { beginEffect } = await import('../../src/domain/effects.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const gate = (effectType: string, key: string) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType, idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0,
});

describe('coverage sees traffic the configured-types report cannot', () => {
  test('a gated type with no policy row is invisible to reconciliationStatus', async () => {
    await gate('payment.unconfigured', 'a-1');

    const status = await reconciliationStatus(getPool(), ws.workspaceId);
    assert.equal(
      status.find((s) => s.effectType === 'payment.unconfigured'), undefined,
      'this documents the gap coverage() exists to close, not desired behaviour',
    );
  });

  test('coverage reports it, and calls the coverage unknown rather than complete', async () => {
    const rows = await coverage(getPool(), ws.workspaceId);
    const row = rows.find((r) => r.effectType === 'payment.unconfigured');

    assert.ok(row, 'a type carrying real traffic must appear in coverage');
    assert.equal(row!.coverage, null,
      'never reconciled means unknown coverage — never 100%');
    assert.equal(row!.status, 'unknown');
    assert.equal(row!.configured, false, 'no policy row, so nothing will ever remind you');
    assert.ok(row!.gatedEffects >= 1, 'it should count the traffic it saw');
  });

  test('an unknown type is not counted as covered in the workspace roll-up', async () => {
    const rows = await coverage(getPool(), ws.workspaceId);
    const unknown = rows.filter((r) => r.status === 'unknown');
    assert.ok(unknown.length >= 1);
    for (const r of unknown) {
      assert.equal(r.coverage, null,
        'an unknown outcome stays unknown — the same rule the state machine follows');
    }
  });

  test('once reconciled, coverage becomes a number rather than a guess', async () => {
    await upsertPolicy(getPool(), ws.workspaceId, {
      effectType: 'payment.measured', reconcileEveryHours: 24,
    });
    await gate('payment.measured', 'm-1');
    await gate('payment.measured', 'm-2');

    const { recordRun } = await import('../../src/domain/reconciliation.js');
    // Four real actions observed at the vendor; three of them asked first.
    await recordRun(getPool(), ws.workspaceId, 'payment.measured',
      { checked: 4, gated: 3, ungated: 1 });

    const row = (await coverage(getPool(), ws.workspaceId))
      .find((r) => r.effectType === 'payment.measured');

    assert.ok(row);
    assert.equal(row!.status, 'measured');
    assert.equal(row!.coverage, 0.75, '3 of 4 observed actions came through the gate');
    assert.equal(row!.ungated, 1);
  });
});
