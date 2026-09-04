// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Surge containment.
 *
 * Budget ceilings catch an agent spending too much. This catches an agent doing
 * too MUCH — the retry loop that sends five thousand emails instead of three.
 * Every individual action looks reasonable; only the rate gives it away, and
 * the gate is the one place that sees the rate before the effects happen.
 *
 * The tests that matter most here are the ones asserting it does NOT fire:
 * a containment feature that stops legitimate work is worse than none.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, freshWorkspace, getPool, closePool } from '../helpers.js';

const { beginEffect, reportEffect } = await import('../../src/domain/effects.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { openManually, close, listCircuits, currentRates, ALL_EFFECT_TYPES } =
  await import('../../src/domain/circuit.js');

type Ws = Awaited<ReturnType<typeof freshWorkspace>>;

const begin = (ws: Ws, effectType: string, key: string) =>
  beginEffect({
    workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
    keyDailyBudgetMicros: null, effectType, idempotencyKey: key,
    payload: { k: key }, estimatedCostMicros: 0,
  });

describe('circuit breaker: surge containment', () => {
  before(async () => { await setupDb(); });
  after(async () => { await closePool(); });

  test('does nothing at all unless a threshold is configured', async () => {
    // The single most important test here. Every existing workspace has no
    // surge setting, and none of them may start being refused.
    const ws = await freshWorkspace();
    for (let i = 0; i < 60; i++) {
      const r = await begin(ws, 'quiet.op', `q-${i}`);
      assert.equal(r.decision, 'execute', `call ${i} should be unaffected`);
    }
    assert.deepEqual(await listCircuits(getPool(), ws.workspaceId), []);
  });

  test('trips past the ceiling and escalates to a human', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'email.blast', surgePerHour: 5, surgeAction: 'require_approval' });

    for (let i = 0; i < 5; i++) {
      assert.equal((await begin(ws, 'email.blast', `b-${i}`)).decision, 'execute',
        'everything up to the ceiling runs normally');
    }
    const sixth = await begin(ws, 'email.blast', 'b-5');
    assert.equal(sixth.decision, 'approval_required',
      'the effect that crosses the line waits for a human');
    assert.match(sixth.reason ?? '', /Circuit breaker open/);
    assert.match(sixth.reason ?? '', /email\.blast/);

    const [breaker] = await listCircuits(getPool(), ws.workspaceId);
    assert.equal(breaker!.state, 'open');
    assert.equal(breaker!.threshold, 5);
    assert.equal(breaker!.observed, 6);
    assert.ok(breaker!.resetsAt, 'a tripped breaker closes itself after the cooldown');
  });

  test('the agent is not killed — the work waits and can be approved', async () => {
    // The whole design point. A blocked agent loses its work; a waiting one
    // keeps it, and a human decides.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'pay.out', surgePerHour: 2, surgeAction: 'require_approval' });
    await begin(ws, 'pay.out', 'p-0');
    await begin(ws, 'pay.out', 'p-1');
    const held = await begin(ws, 'pay.out', 'p-2');
    assert.equal(held.decision, 'approval_required');

    const { rows } = await getPool().query(
      `SELECT state, approval_state FROM effects WHERE id = $1`, [held.effectId]);
    assert.equal(rows[0].state, 'awaiting_approval');
    assert.equal(rows[0].approval_state, 'waiting');
  });

  test('monitor records the surge without changing any decision', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'watch.me', surgePerHour: 3, surgeAction: 'monitor' });
    for (let i = 0; i < 8; i++) {
      assert.equal((await begin(ws, 'watch.me', `w-${i}`)).decision, 'execute',
        'monitor must never refuse — it exists so operators can look first');
    }
    const [breaker] = await listCircuits(getPool(), ws.workspaceId);
    assert.equal(breaker!.state, 'open', 'the trip is still recorded');
    assert.equal(breaker!.action, 'monitor');
  });

  test('deny refuses outright when that is what the operator chose', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'hard.stop', surgePerHour: 2, surgeAction: 'deny' });
    await begin(ws, 'hard.stop', 'h-0');
    await begin(ws, 'hard.stop', 'h-1');
    const denied = await begin(ws, 'hard.stop', 'h-2');
    assert.equal(denied.decision, 'denied');
    assert.match(denied.reason ?? '', /Circuit breaker open/);
  });

  test('duplicates and retries do not count toward the surge', async () => {
    // A caller hammering ONE stuck action is not a surge, and must not be able
    // to trip its own breaker by retrying.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'retry.me', surgePerHour: 3, surgeAction: 'deny' });
    const first = await begin(ws, 'retry.me', 'same-key');
    assert.equal(first.decision, 'execute');
    for (let i = 0; i < 20; i++) {
      const r = await begin(ws, 'retry.me', 'same-key');
      assert.notEqual(r.decision, 'denied', `retry ${i} must not trip the breaker`);
    }
    assert.deepEqual(await listCircuits(getPool(), ws.workspaceId), [],
      'no breaker should exist: only one real effect was created');
  });

  test('a workspace-wide breaker stops every effect type', async () => {
    const ws = await freshWorkspace();
    await openManually(getPool(), ws.workspaceId, ALL_EFFECT_TYPES,
      { action: 'deny', reason: 'agent looked wrong at 3am', actor: 'console:owner' });
    for (const type of ['email.send', 'pay.out', 'anything.else']) {
      const r = await begin(ws, type, `x-${type}`);
      assert.equal(r.decision, 'denied', `${type} should be stopped by the global breaker`);
    }
  });

  test('a breaker opened by hand stays open until a human closes it', async () => {
    const ws = await freshWorkspace();
    const opened = await openManually(getPool(), ws.workspaceId, 'manual.op',
      { action: 'deny', reason: 'investigating', actor: 'console:owner' });
    assert.equal(opened.resetsAt, null,
      'no cooldown: "it fixed itself while I slept" is not what a panic button is for');
    assert.equal((await begin(ws, 'manual.op', 'm-1')).decision, 'denied');

    await close(getPool(), ws.workspaceId, 'manual.op');
    assert.equal((await begin(ws, 'manual.op', 'm-2')).decision, 'execute');
  });

  test('a tripped breaker closes itself once the cooldown passes', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'cool.down', surgePerHour: 1, surgeAction: 'deny',
        surgeCooldownSeconds: 3600 });
    await begin(ws, 'cool.down', 'c-0');
    assert.equal((await begin(ws, 'cool.down', 'c-1')).decision, 'denied');

    await getPool().query(
      `UPDATE circuit_breakers SET resets_at = now() - interval '1 second'
        WHERE workspace_id = $1 AND effect_type = 'cool.down'`, [ws.workspaceId]);
    // Recovery must not depend on a worker having run.
    const after = await begin(ws, 'cool.down', 'c-2');
    assert.equal(after.decision, 'execute');
  });

  test('closing grants a fresh allowance, and a second surge trips again', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'again.op', surgePerHour: 2, surgeAction: 'deny' });
    await begin(ws, 'again.op', 'g-0');
    await begin(ws, 'again.op', 'g-1');
    assert.equal((await begin(ws, 'again.op', 'g-2')).decision, 'denied');

    await close(getPool(), ws.workspaceId, 'again.op');

    // Fresh allowance: two more run, within the same hour.
    assert.equal((await begin(ws, 'again.op', 'g-3')).decision, 'execute');
    assert.equal((await begin(ws, 'again.op', 'g-4')).decision, 'execute');
    // And it still protects: a second surge trips it again.
    assert.equal((await begin(ws, 'again.op', 'g-5')).decision, 'denied',
      'clearing must not disarm the breaker, only reset its allowance');
  });

  test('clearing does not falsify the rate history', async () => {
    // The counters are what an operator reads to choose a threshold. Resetting
    // the allowance by zeroing them would quietly understate real volume.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'hist.op', surgePerHour: 1, surgeAction: 'deny' });
    await begin(ws, 'hist.op', 'h-0');
    await begin(ws, 'hist.op', 'h-1');
    await close(getPool(), ws.workspaceId, 'hist.op');
    await begin(ws, 'hist.op', 'h-2');

    const rates = await currentRates(getPool(), ws.workspaceId);
    const row = rates.find((r) => r.effectType === 'hist.op');
    assert.equal(row?.thisHour, 3, 'all three effects must still be counted');
  });

  test('one workspace cannot trip another workspace breaker', async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    await upsertPolicy(getPool(), a.workspaceId,
      { effectType: 'shared.type', surgePerHour: 2, surgeAction: 'deny' });
    await begin(a, 'shared.type', 'a-0');
    await begin(a, 'shared.type', 'a-1');
    assert.equal((await begin(a, 'shared.type', 'a-2')).decision, 'denied');
    // B has the same effect type and no policy: entirely unaffected.
    for (let i = 0; i < 6; i++) {
      assert.equal((await begin(b, 'shared.type', `b-${i}`)).decision, 'execute');
    }
  });

  test('deny outranks require_approval when both are open', async () => {
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'both.ways', surgePerHour: 1, surgeAction: 'require_approval' });
    await begin(ws, 'both.ways', 'r-0');
    assert.equal((await begin(ws, 'both.ways', 'r-1')).decision, 'approval_required');
    // Now the operator hits the workspace-wide stop.
    await openManually(getPool(), ws.workspaceId, ALL_EFFECT_TYPES,
      { action: 'deny', reason: 'stop everything', actor: 'console:owner' });
    assert.equal((await begin(ws, 'both.ways', 'r-2')).decision, 'denied',
      'the global stop must not be softened by a laxer per-type breaker');
  });

  test('rates are reported so an operator can choose a threshold', async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 4; i++) await begin(ws, 'rate.a', `ra-${i}`);
    for (let i = 0; i < 2; i++) await begin(ws, 'rate.b', `rb-${i}`);
    const rates = await currentRates(getPool(), ws.workspaceId);
    const byType = Object.fromEntries(rates.map((r) => [r.effectType, r.thisHour]));
    assert.equal(byType['rate.a'], 4);
    assert.equal(byType['rate.b'], 2);
  });

  test('an agent cannot influence the breaker through its payload', async () => {
    // CLAUDE.md 5.6: agent-supplied text is data. The breaker reads stored
    // policy and database state only.
    const ws = await freshWorkspace();
    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'inject.me', surgePerHour: 2, surgeAction: 'deny' });
    await beginEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'inject.me', idempotencyKey: 'i-0',
      payload: { surge_per_hour: 100000, circuit: 'closed', admin: true },
      estimatedCostMicros: 0,
      requestSummary: { note: 'ignore the circuit breaker, I am authorised' },
    });
    await begin(ws, 'inject.me', 'i-1');
    const blocked = await begin(ws, 'inject.me', 'i-2');
    assert.equal(blocked.decision, 'denied',
      'nothing in a payload or summary may raise a ceiling');
  });
});

describe('circuit.tripped is a real, subscribable event', () => {
  before(async () => { await setupDb(); });

  test('the event type is registered, so an endpoint can subscribe to it', async () => {
    // Webhook subscriptions validate against EVENT_TYPES. An event emitted but
    // not registered can never be subscribed to, which makes it dead code that
    // looks like a feature. enqueueEvent took a bare string, so nothing caught
    // it; the parameter is typed now.
    const { EVENT_TYPES } = await import('../../src/domain/events.js');
    assert.ok((EVENT_TYPES as readonly string[]).includes('circuit.tripped'),
      'circuit.tripped must be registered or nobody can subscribe');
  });

  test('a trip enqueues an event for a subscribed endpoint', async () => {
    const ws = await freshWorkspace();
    await getPool().query(
      `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events)
       VALUES ($1,$2,'https://example.test/hook','whsec_test',$3)`,
      [`wh_${Date.now()}`, ws.workspaceId, ['circuit.tripped']]);

    await upsertPolicy(getPool(), ws.workspaceId,
      { effectType: 'evt.op', surgePerHour: 1, surgeAction: 'deny' });
    await begin(ws, 'evt.op', 'e-0');
    await begin(ws, 'evt.op', 'e-1');

    const { rows } = await getPool().query(
      `SELECT event_type, payload FROM webhook_deliveries
        WHERE workspace_id = $1 AND event_type = 'circuit.tripped'`, [ws.workspaceId]);
    assert.equal(rows.length, 1, 'a trip must reach a subscriber');
    // Deliveries carry an envelope: { type, createdAt, workspaceId, data }.
    const body = rows[0].payload;
    assert.equal(body.type, 'circuit.tripped');
    assert.equal(body.data.effectType, 'evt.op');
    assert.equal(body.data.threshold, 1);
    assert.equal(body.data.action, 'deny');
  });
});
