// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Relative surge thresholds.
 *
 * `surge_per_hour` requires knowing your own traffic, which most people do not
 * — so the safest setting is the one hardest to choose, and the workspaces
 * least likely to have configured anything are exactly the ones a runaway agent
 * will hurt most. `surge_multiplier` asks a question anyone can answer instead:
 * how many times normal is definitely wrong?
 *
 * The tests that matter most are the ones proving it does NOT fire: on a new
 * effect type with no history, and on small traffic where a multiple of a tiny
 * number would otherwise be a tiny number.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, freshWorkspace, getPool, closePool } from '../helpers.js';

const { beginEffect } = await import('../../src/domain/effects.js');
const { upsertPolicy, getPolicy } = await import('../../src/domain/policy.js');
const {
  refreshSurgeBaselines, effectiveCeiling, listCircuits,
  LEARNED_CEILING_FLOOR, MIN_BASELINE_SAMPLES,
} = await import('../../src/domain/circuit.js');

type Ws = Awaited<ReturnType<typeof freshWorkspace>>;

const begin = (ws: Ws, effectType: string, key: string) =>
  beginEffect({
    workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
    keyDailyBudgetMicros: null, effectType, idempotencyKey: key,
    payload: { k: key }, estimatedCostMicros: 0,
  });

/** Fabricate history: `perHour` effects in each of the last `hours` complete hours. */
const seedHistory = (ws: Ws, effectType: string, perHour: number, hours: number) =>
  getPool().query(
    `INSERT INTO effect_rate_windows (workspace_id, effect_type, hour_start, count)
     SELECT $1, $2, date_trunc('hour', now()) - (g || ' hours')::interval, $3
       FROM generate_series(1, $4) g
     ON CONFLICT (workspace_id, effect_type, hour_start)
     DO UPDATE SET count = EXCLUDED.count`,
    [ws.workspaceId, effectType, perHour, hours]);

describe('learned surge thresholds', () => {
  before(async () => { await setupDb(); });
  after(async () => { await closePool(); });

  test('a multiplier does nothing until there is history to multiply', async () => {
    // A brand new effect type has no normal to be a multiple of. Guessing one
    // would mean refusing real work on day one.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'new.type', surgeMultiplier: 10, surgeAction: 'deny' });
    await refreshSurgeBaselines();

    const p = await getPolicy(getPool(), ws.workspaceId, 'new.type');
    assert.equal(p.surgeBaselinePerHour, null, 'no baseline without history');
    assert.equal(effectiveCeiling(p).ceiling, null, 'and therefore no ceiling');

    for (let i = 0; i < 40; i++) {
      assert.equal((await begin(ws, 'new.type', `n-${i}`)).decision, 'execute');
    }
  });

  test('too little history is not enough history', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'thin.type', surgeMultiplier: 10 });
    await seedHistory(ws, 'thin.type', 100, MIN_BASELINE_SAMPLES - 1);
    await refreshSurgeBaselines();
    const p = await getPolicy(getPool(), ws.workspaceId, 'thin.type');
    assert.equal(p.surgeBaselinePerHour, null,
      `fewer than ${MIN_BASELINE_SAMPLES} hours must not produce a baseline`);
  });

  test('a baseline is the median of real hourly volume', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'steady.type', surgeMultiplier: 10 });
    await seedHistory(ws, 'steady.type', 200, 24);
    await refreshSurgeBaselines();

    const p = await getPolicy(getPool(), ws.workspaceId, 'steady.type');
    assert.equal(p.surgeBaselinePerHour, 200);
    assert.ok(p.surgeBaselineAt instanceof Date);
    const eff = effectiveCeiling(p);
    assert.equal(eff.ceiling, 2000);
    assert.equal(eff.source, 'learned');
  });

  test('one runaway hour does not raise the ceiling that should catch the next', async () => {
    // The median, not the mean, precisely for this.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'spiky.type', surgeMultiplier: 10 });
    await seedHistory(ws, 'spiky.type', 10, 24);
    await getPool().query(
      `UPDATE effect_rate_windows SET count = 100000
        WHERE workspace_id = $1 AND effect_type = 'spiky.type'
          AND hour_start = date_trunc('hour', now()) - interval '3 hours'`,
      [ws.workspaceId]);
    await refreshSurgeBaselines();
    const p = await getPolicy(getPool(), ws.workspaceId, 'spiky.type');
    assert.equal(p.surgeBaselinePerHour, 10,
      'a single enormous hour must not drag the baseline up');
  });

  test('small traffic gets the floor, not a tiny ceiling', async () => {
    // Two an hour times ten is twenty, and twenty is noise. Without a floor a
    // quiet workspace would trip on an ordinary busy afternoon.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'quiet.type', surgeMultiplier: 10, surgeAction: 'deny' });
    await seedHistory(ws, 'quiet.type', 2, 24);
    await refreshSurgeBaselines();

    const p = await getPolicy(getPool(), ws.workspaceId, 'quiet.type');
    assert.equal(effectiveCeiling(p).ceiling, LEARNED_CEILING_FLOOR);

    for (let i = 0; i < LEARNED_CEILING_FLOOR; i++) {
      assert.equal((await begin(ws, 'quiet.type', `q-${i}`)).decision, 'execute',
        `call ${i} is within the floor and must run`);
    }
  });

  test('a genuine surge against a learned ceiling trips', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'loop.type', surgeMultiplier: 5, surgeAction: 'deny' });
    await seedHistory(ws, 'loop.type', 10, 24);   // ceiling = max(30, 50) = 50
    await refreshSurgeBaselines();

    let denied = 0;
    for (let i = 0; i < 60; i++) {
      if ((await begin(ws, 'loop.type', `l-${i}`)).decision === 'denied') denied++;
    }
    assert.ok(denied > 0, 'a 6x surge past the learned ceiling must be caught');

    const [breaker] = await listCircuits(getPool(), ws.workspaceId);
    assert.equal(breaker!.threshold, 50);
    assert.match(breaker!.reason ?? '', /normal of about 10 an hour/);
    assert.match(breaker!.reason ?? '', /5x/);
  });

  test('an explicit ceiling wins over a multiplier', async () => {
    // You asked for a number; you get that number.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'both.type', surgePerHour: 7, surgeMultiplier: 1000 });
    await seedHistory(ws, 'both.type', 500, 24);
    await refreshSurgeBaselines();
    const p = await getPolicy(getPool(), ws.workspaceId, 'both.type');
    const eff = effectiveCeiling(p);
    assert.equal(eff.ceiling, 7);
    assert.equal(eff.source, 'absolute');
  });

  test('baselines are only computed for policies that asked for one', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId, { effectType: 'noopt.type' });
    await seedHistory(ws, 'noopt.type', 300, 24);
    await refreshSurgeBaselines();
    const p = await getPolicy(getPool(), ws.workspaceId, 'noopt.type');
    assert.equal(p.surgeBaselinePerHour, null,
      'no multiplier set means no baseline work is done at all');
  });

  test('the current, incomplete hour is excluded from the baseline', async () => {
    // Including it would let a surge in progress inflate the ceiling meant to
    // stop it — the baseline would chase the runaway upward.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'now.type', surgeMultiplier: 10 });
    await seedHistory(ws, 'now.type', 10, 24);
    await getPool().query(
      `INSERT INTO effect_rate_windows (workspace_id, effect_type, hour_start, count)
       VALUES ($1, 'now.type', date_trunc('hour', now()), 99999)
       ON CONFLICT (workspace_id, effect_type, hour_start) DO UPDATE SET count = 99999`,
      [ws.workspaceId]);
    await refreshSurgeBaselines();
    const p = await getPolicy(getPool(), ws.workspaceId, 'now.type');
    assert.equal(p.surgeBaselinePerHour, 10, 'the in-progress hour must not count');
  });
});
