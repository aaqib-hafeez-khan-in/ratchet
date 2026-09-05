// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool, expireLease } from '../helpers.js';

const { beginEffect, reportEffect, resolveEffect } = await import('../../src/domain/effects.js');
const { unwindGroup, getGroup, commitGroup } = await import('../../src/domain/groups.js');
const { sweepExpiredLeases } = await import('../../src/worker/reaper.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(false); });
after(async () => { await closePool(); });

// The spread is the point of this helper — each caller overrides a different
// field — and a spread of Record<string, any> cannot prove to the compiler
// that effect_type and idempotency_key survived it.
const begin = (o: Record<string, any>) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, payload: o.payload ?? {}, estimatedCostMicros: 0, ...o,
} as Parameters<typeof beginEffect>[0]);
const report = (r: any, outcome: 'succeeded' | 'failed' = 'succeeded', result: any = {}) =>
  reportEffect({
    workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
    effectId: r.effectId, leaseToken: r.leaseToken!, outcome, result,
    failureReason: outcome === 'failed' ? 'declined' : undefined,
  });

/** Books a flight and a hotel, both reversible. Payment then fails. */
async function bookTrip(key: string) {
  const flight = await begin({
    effectType: 'flight.book', idempotencyKey: `${key}:flight`, groupKey: key,
    compensation: { effectType: 'flight.cancel', payload: { ref: 'FL123' } },
  });
  await report(flight, 'succeeded', { booking: 'FL123' });

  const hotel = await begin({
    effectType: 'hotel.book', idempotencyKey: `${key}:hotel`, groupKey: key,
    compensation: { effectType: 'hotel.cancel', payload: { ref: 'HT456' } },
  });
  await report(hotel, 'succeeded', { booking: 'HT456' });

  const pay = await begin({
    effectType: 'payment.charge', idempotencyKey: `${key}:pay`, groupKey: key,
  });
  await report(pay, 'failed');
  return { flight, hotel, pay };
}

describe('reversible effect groups', () => {
  test('a failed unit of work yields a plan in REVERSE completion order', async () => {
    const key = 'trip:1';
    const { flight, hotel } = await bookTrip(key);

    const plan = await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key, reason: 'payment declined' });
    assert.equal(plan.state, 'unwinding');
    assert.equal(plan.steps.length, 2, 'only the two succeeded, reversible steps');

    // Reverse order matters: undoing forward can strand a dependent step.
    assert.equal(plan.steps[0]!.originalEffectId, hotel.effectId, 'hotel booked last, undone first');
    assert.equal(plan.steps[1]!.originalEffectId, flight.effectId);
    assert.equal(plan.steps[0]!.compensation.effectType, 'hotel.cancel');

    // The failed payment never happened, so it is not in the plan.
    assert.equal(plan.steps.some((s) => s.originalEffectType === 'payment.charge'), false);
    // The plan carries the original result, which the undo usually needs.
    assert.deepEqual(plan.steps[1]!.originalResult, { booking: 'FL123' });
  });

  test('a group being unwound refuses new forward steps', async () => {
    const key = 'trip:2';
    await bookTrip(key);
    await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key });

    await assert.rejects(
      () => begin({ effectType: 'car.book', idempotencyKey: `${key}:car`, groupKey: key }),
      (e: any) => e.code === 'group_unwinding',
      'adding steps to a unit being rolled back is how a half-undone state is created',
    );
  });

  test('performing the compensations settles the group as unwound', async () => {
    const key = 'trip:3';
    await bookTrip(key);
    const plan = await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key });

    for (const step of plan.steps) {
      const c = await begin({
        effectType: step.compensation.effectType,
        idempotencyKey: step.suggestedIdempotencyKey,
        payload: step.compensation.payload,
        compensatesEffectId: step.originalEffectId,
      });
      assert.equal(c.decision, 'execute');
      await report(c, 'succeeded', { cancelled: true });
    }

    const after = await getGroup(getPool(), ws.workspaceId, key);
    assert.equal(after!.state, 'unwound');
    assert.equal(after!.steps.every((s) => s.status === 'done'), true);
  });

  test('the undo is itself at-most-once — a retried compensation cannot double-refund', async () => {
    const key = 'trip:4';
    await bookTrip(key);
    const plan = await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key });
    const step = plan.steps[0]!;

    const first = await begin({
      effectType: step.compensation.effectType, idempotencyKey: step.suggestedIdempotencyKey,
      payload: step.compensation.payload, compensatesEffectId: step.originalEffectId,
    });
    await report(first, 'succeeded', { refunded: true });

    // A crashed-and-retried agent asks again. This is the dangerous moment.
    const again = await begin({
      effectType: step.compensation.effectType, idempotencyKey: step.suggestedIdempotencyKey,
      payload: step.compensation.payload, compensatesEffectId: step.originalEffectId,
    });
    assert.equal(again.decision, 'duplicate', 'the undo must not run twice');
    assert.deepEqual(again.result, { refunded: true });
  });

  test('a step with no compensation is reported as irreversible, not silently ignored', async () => {
    const key = 'trip:5';
    const mail = await begin({
      effectType: 'email.send', idempotencyKey: `${key}:mail`, groupKey: key,
      // An email cannot be unsent. Declaring nothing is the honest answer.
    });
    await report(mail, 'succeeded', { messageId: 'm1' });
    const book = await begin({
      effectType: 'flight.book', idempotencyKey: `${key}:flight`, groupKey: key,
      compensation: { effectType: 'flight.cancel', payload: { ref: 'X' } },
    });
    await report(book, 'succeeded', { booking: 'X' });

    const plan = await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key });
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.irreversible.length, 1);
    assert.equal(plan.irreversible[0]!.effectType, 'email.send');
    assert.match(plan.nextStep, /compensation/i);
  });

  test('a group with an irreversible step ends unwind_failed, never claiming clean rollback', async () => {
    const key = 'trip:6';
    const mail = await begin({ effectType: 'email.send', idempotencyKey: `${key}:m`, groupKey: key });
    await report(mail, 'succeeded', {});
    const book = await begin({
      effectType: 'flight.book', idempotencyKey: `${key}:f`, groupKey: key,
      compensation: { effectType: 'flight.cancel', payload: {} },
    });
    await report(book, 'succeeded', {});

    const plan = await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key });
    const step = plan.steps[0]!;
    const c = await begin({
      effectType: 'flight.cancel', idempotencyKey: step.suggestedIdempotencyKey,
      compensatesEffectId: step.originalEffectId,
    });
    await report(c, 'succeeded', {});

    const after = await getGroup(getPool(), ws.workspaceId, key);
    assert.equal(after!.state, 'unwind_failed',
      'an email was sent and cannot be unsent; calling this "unwound" would be a lie');
    assert.equal(after!.irreversible.length, 1);
  });

  test('an unknown outcome blocks planning around it', async () => {
    const key = 'trip:7';
    const book = await begin({
      effectType: 'flight.book', idempotencyKey: `${key}:f`, groupKey: key,
      compensation: { effectType: 'flight.cancel', payload: {} },
    });
    await report(book, 'succeeded', {});
    const pay = await begin({
      effectType: 'payment.charge', idempotencyKey: `${key}:p`, groupKey: key, leaseSeconds: 5,
      compensation: { effectType: 'payment.refund', payload: {} },
    });
    await expireLease(pay.effectId);
    // The reaper turns an expired lease into `indeterminate`; it runs every two
    // seconds in production, so drive it here rather than waiting.
    await sweepExpiredLeases();

    const plan = await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key });
    assert.equal(plan.unresolved.length, 1);
    assert.match(plan.nextStep, /^STOP/);
    assert.match(plan.nextStep, /unknown outcome/i);

    // Once resolved, it enters the plan properly.
    await resolveEffect({
      workspaceId: ws.workspaceId, effectId: pay.effectId, actor: 'test',
      outcome: 'succeeded', evidence: 'vendor shows the charge',
    });
    const after = await getGroup(getPool(), ws.workspaceId, key);
    assert.equal(after!.unresolved.length, 0);
    assert.equal(after!.steps.length, 2);
  });

  test('groups are workspace-scoped', async () => {
    const other = await freshWorkspace(false);
    await bookTrip('trip:iso');
    assert.equal(await getGroup(getPool(), other.workspaceId, 'trip:iso'), null);
    await assert.rejects(
      () => unwindGroup({ workspaceId: other.workspaceId, groupKey: 'trip:iso' }),
      (e: any) => e.code === 'not_found');
  });

  test('a committed group can still be unwound later', async () => {
    const key = 'trip:8';
    const book = await begin({
      effectType: 'flight.book', idempotencyKey: `${key}:f`, groupKey: key,
      compensation: { effectType: 'flight.cancel', payload: {} },
    });
    await report(book, 'succeeded', {});
    assert.equal((await commitGroup({ workspaceId: ws.workspaceId, groupKey: key })).state, 'committed');

    // A trip booked correctly, then cancelled by the customer next day.
    const plan = await unwindGroup({ workspaceId: ws.workspaceId, groupKey: key, reason: 'customer cancelled' });
    assert.equal(plan.state, 'unwinding');
    assert.equal(plan.steps.length, 1);
  });
});
