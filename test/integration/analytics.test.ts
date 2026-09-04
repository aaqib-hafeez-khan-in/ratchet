// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool, expireLease } from '../helpers.js';

const { beginEffect, reportEffect, resolveEffect } = await import('../../src/domain/effects.js');
const { computeMetrics } = await import('../../src/domain/metrics.js');
const { sweepExpiredLeases } = await import('../../src/worker/reaper.js');
const { flushActivity } = await import('../../src/domain/activity.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(false); });
after(async () => { await closePool(); });

const begin = (key: string, type = 'email.send', leaseSeconds?: number) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: type, idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0,
  ...(leaseSeconds ? { leaseSeconds } : {}),
});

/**
 * Counters are buffered and flushed on a timer; force the flush rather than
 * sleeping. Milestones are still written immediately, so a short wait covers
 * those.
 */
const settle = async () => {
  await flushActivity();
  await new Promise((r) => setTimeout(r, 120));
};

const milestones = async () => (await getPool().query<{ milestone: string }>(
  'SELECT milestone FROM workspace_milestones WHERE workspace_id = $1', [ws.workspaceId]
)).rows.map((r) => r.milestone);

const activity = async () => (await getPool().query(
  'SELECT * FROM workspace_activity WHERE workspace_id = $1', [ws.workspaceId])).rows[0] as any;

describe('product analytics', () => {
  test('workspace creation is recorded at signup', async () => {
    assert.ok((await milestones()).includes('workspace_created'));
  });

  test('a first begin and a first success are recorded once each', async () => {
    const a = await begin('an-1');
    await settle();
    assert.ok((await milestones()).includes('first_begin'));

    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded', result: {},
    });
    await settle();
    assert.ok((await milestones()).includes('first_success'),
      'activation is a completed execute → report cycle');

    // Milestones are first-time-only, so more work must not duplicate them.
    const b = await begin('an-2');
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: b.effectId, leaseToken: b.leaseToken!, outcome: 'succeeded', result: {},
    });
    await settle();
    const all = await milestones();
    assert.equal(all.filter((m) => m === 'first_success').length, 1);
  });

  test('daily counters accumulate rather than duplicating rows', async () => {
    const row = await activity();
    assert.ok(row, 'one row per workspace per UTC day');
    assert.ok(row.effects_begun >= 2);
    assert.ok(row.effects_succeeded >= 2);
    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM workspace_activity WHERE workspace_id = $1', [ws.workspaceId]);
    assert.equal(rows[0].n, 1, 'a single day must produce a single row');
  });

  test('duplicate suppression is not counted as new usage', async () => {
    const before = (await activity()).effects_begun;
    for (let i = 0; i < 5; i++) await begin('an-1');   // all duplicates
    await settle();
    assert.equal((await activity()).effects_begun, before,
      'only newly created effects count, matching what is metered');
  });

  test('the reaper records indeterminate outcomes atomically', async () => {
    const c = await begin('an-crash', 'payment.charge', 5);
    await expireLease(c.effectId);
    await sweepExpiredLeases();
    // No settle() — the worker path writes inside its transaction on purpose,
    // because a fire-and-forget write can be lost when the process exits.
    const row = await activity();
    assert.ok(row.effects_indeterminate >= 1);
    assert.ok((await milestones()).includes('first_indeterminate'));
  });

  test('resolving an indeterminate effect is recorded', async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM effects WHERE workspace_id = $1 AND state = 'indeterminate' LIMIT 1`,
      [ws.workspaceId]);
    await resolveEffect({
      workspaceId: ws.workspaceId, effectId: rows[0]!.id, actor: 'test',
      outcome: 'succeeded', evidence: 'checked the vendor',
    });
    await settle();
    assert.ok((await milestones()).includes('first_resolve'));
  });

  test('analytics survive retention GC, which deletes the effects themselves', async () => {
    // The reason these tables exist: effect rows are collected at their
    // retention horizon, which would otherwise erase all cohort evidence.
    await getPool().query('DELETE FROM effects WHERE workspace_id = $1', [ws.workspaceId]);
    const row = await activity();
    assert.ok(row.effects_begun >= 2, 'activity must outlive the effects it counted');
    assert.ok((await milestones()).includes('first_success'));
  });
});

describe('metrics report', () => {
  test('computes the thresholds the pricing review named', async () => {
    const m = await computeMetrics(30);
    assert.ok(m.workspaces.total >= 1);
    assert.ok(m.activation.activated >= 1);
    assert.ok(m.activation.activationRate !== null);
    assert.ok(m.activation.medianMinutesToFirstSuccess !== null);
    assert.ok(m.usage.activeWorkspacesLast7Days >= 1);
    assert.ok(m.usage.effectsBegunLast30Days >= 2);
    assert.ok(m.usage.indeterminateRate !== null);
    assert.equal(typeof m.revenue.creditOutstandingMicros, 'number');
  });

  test('rates are null rather than misleading when there is no denominator', async () => {
    const m = await computeMetrics(30);
    // No workspace is old enough for month-3 retention in a fresh test database.
    assert.equal(m.retention.month3, null,
      'an unanswerable metric must report null, not zero');
  });
});
