/**
 * An agent asking what it already did.
 *
 * The failure this exists for is not exotic. An agent restarts, or its context
 * is compacted, and it no longer knows whether it charged the card. It then
 * either repeats the work, or re-derives the answer from the vendor at the cost
 * of several calls and a model turn, or asks a human. Ratchet already wrote
 * down what happened; this is reading it back.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';

const { beginEffect, reportEffect } = await import('../../src/domain/effects.js');
const { recallRun } = await import('../../src/domain/recall.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const begin = (key: string, runId: string, type = 'email.send', cost = 0) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: type, idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: cost, runId,
});

describe('recalling a run', () => {
  test('an unknown run is empty and says so without alarming anyone', async () => {
    const r = await recallRun(ws.workspaceId, 'never-happened');
    assert.equal(r.steps, 0);
    assert.deepEqual(r.done, []);
    assert.match(r.next, /Nothing has been done/);
  });

  test('a completed step is remembered with its result', async () => {
    const run = `run-done-${Date.now()}`;
    const b = await begin('step-1', run);
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: b.effectId, leaseToken: b.leaseToken!, outcome: 'succeeded',
      result: { messageId: 'msg_abc' },
    });

    const r = await recallRun(ws.workspaceId, run);
    assert.equal(r.steps, 1);
    assert.equal(r.done.length, 1);
    assert.equal(r.done[0]!.what, 'email.send');
    assert.equal(r.done[0]!.key, 'step-1');
    // The recorded result is the whole point: it is what the caller would
    // otherwise go back to the vendor for.
    assert.deepEqual(r.done[0]!.result, { messageId: 'msg_abc' });
    assert.match(r.next, /already happened/);
  });

  test('work in flight is separated from work that is finished', async () => {
    const run = `run-mixed-${Date.now()}`;
    const a = await begin('done-1', run);
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded', result: { ok: true },
    });
    await begin('open-1', run);      // begun, never reported

    const r = await recallRun(ws.workspaceId, run);
    assert.equal(r.done.length, 1);
    assert.equal(r.inFlight.length, 1);
    assert.equal(r.inFlight[0]!.key, 'open-1');
    assert.match(r.next, /still in flight/);
  });

  // The category that can hurt. An agent acting around an effect that may or
  // may not have happened is how half-finished real-world state gets made, so
  // an unknown outranks everything else in the guidance.
  test('an unknown outcome outranks everything else in what to do next', async () => {
    const run = `run-unknown-${Date.now()}`;
    const a = await begin('settled', run);
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded', result: {},
    });
    const b = await begin('lost', run);
    await getPool().query(
      "UPDATE effects SET state = 'indeterminate' WHERE id = $1", [b.effectId]);
    await begin('also-open', run);

    const r = await recallRun(ws.workspaceId, run);
    assert.equal(r.unknown.length, 1);
    assert.equal(r.unknown[0]!.key, 'lost');
    assert.match(r.next, /^STOP\./,
      'an unknown outcome must be the first thing the caller is told');
    assert.doesNotMatch(r.next, /still in flight/,
      'the in-flight note must not displace the dangerous one');
  });

  test('spend across the run is totalled, so the agent need not add it up', async () => {
    const run = `run-spend-${Date.now()}`;
    const a = await begin('charge-1', run, 'payment.charge', 150_000);
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: a.effectId, leaseToken: a.leaseToken!, outcome: 'succeeded',
      result: {}, actualCostMicros: 150_000,
    });
    await begin('charge-2', run, 'payment.charge', 90_000);

    const r = await recallRun(ws.workspaceId, run);
    assert.equal(r.spentMicros, 240_000,
      'settled spend plus what is still reserved is what this task has cost so far');
  });

  test('one run cannot see another run, or another tenant', async () => {
    const mine = `mine-${Date.now()}`;
    const theirs = `theirs-${Date.now()}`;
    await begin('a', mine);
    await begin('b', theirs);

    assert.equal((await recallRun(ws.workspaceId, mine)).steps, 1);

    const other = await freshWorkspace();
    assert.equal((await recallRun(other.workspaceId, mine)).steps, 0,
      'a run id is not a capability; it must be scoped to the workspace');
  });

  /**
   * The reason this is a separate shape rather than a filter on listEffects.
   * A memory that costs more than re-deriving the answer does not get used.
   */
  test('the digest is far smaller than listing the same effects', async () => {
    const run = `run-size-${Date.now()}`;
    for (let i = 0; i < 12; i++) {
      const b = await begin(`s-${i}`, run);
      await reportEffect({
        workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
        effectId: b.effectId, leaseToken: b.leaseToken!, outcome: 'succeeded', result: { i },
      });
    }

    const digest = JSON.stringify(await recallRun(ws.workspaceId, run));
    const { rows } = await getPool().query(
      'SELECT * FROM effects WHERE workspace_id = $1 AND run_id = $2',
      [ws.workspaceId, run]);
    const full = JSON.stringify(rows);

    assert.equal(rows.length, 12);
    assert.ok(digest.length * 4 < full.length,
      `the digest should be several times smaller: ${digest.length} vs ${full.length} bytes`);
  });
});
