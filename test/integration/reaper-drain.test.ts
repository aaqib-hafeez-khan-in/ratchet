// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The reaper must clear a burst, not nibble at it.
 *
 * The worker used to call sweepExpiredLeases() once per tick, which capped the
 * pending → indeterminate transition at one batch per interval: 25/second at
 * the defaults, while the same code measured above 1,300/second when allowed to
 * run continuously. A fleet of agents dying at once produces precisely that
 * backlog, and until an effect is swept it stays `pending`, so a caller
 * retrying is told `in_flight` and learns nothing.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, freshWorkspace, getPool, closePool } from '../helpers.js';

const { drainExpiredLeases, sweepExpiredLeases } = await import('../../src/worker/reaper.js');
const { beginEffect } = await import('../../src/domain/effects.js');

type Ws = Awaited<ReturnType<typeof freshWorkspace>>;

const begin = (ws: Ws, effectType: string, idempotencyKey: string) =>
  beginEffect({
    workspaceId: ws.workspaceId,
    apiKeyId: ws.key.id,
    apiKeyPrefix: ws.key.prefix,
    keyDailyBudgetMicros: null,
    effectType,
    idempotencyKey,
    payload: { k: idempotencyKey },
    estimatedCostMicros: 0,
  });

/** Expire every live lease in one workspace, as if its whole fleet died at once. */
const killFleet = (ws: Ws) => getPool().query(
  `UPDATE effects SET lease_expires_at = now() - interval '1 second'
    WHERE workspace_id = $1 AND state = 'pending'`, [ws.workspaceId]);

describe('reaper drains a burst of abandoned leases', () => {
  before(async () => { await setupDb(); });
  after(async () => { await closePool(); });

  test('one drain clears far more than one batch', async () => {
    const ws = await freshWorkspace();
    // The sweep is oldest-first, so anything already expired in this database
    // is ahead of us in the queue and would eat the drain's batch budget. Clear
    // it first: this test is about the drain's reach, not the queue's depth.
    await drainExpiredLeases({ maxBatches: 1000 });

    const N = 120;                       // more than two default batches
    for (let i = 0; i < N; i++) {
      await begin(ws, 'reap.burst', `burst-${i}`);
    }
    await killFleet(ws);

    const swept = await drainExpiredLeases();
    assert.ok(swept >= N, `drain swept ${swept}, expected at least ${N}`);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM effects
        WHERE workspace_id = $1 AND state = 'indeterminate'`, [ws.workspaceId]);
    assert.equal(rows[0].n, N, 'every abandoned lease should be indeterminate');
  });

  test('a single batch is still bounded, so locks stay short', async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 60; i++) {
      await begin(ws, 'reap.batch', `batch-${i}`);
    }
    await killFleet(ws);
    const n = await sweepExpiredLeases(50);
    assert.equal(n, 50, 'the single-batch primitive must respect its batch size');
    await drainExpiredLeases();
  });

  test('draining an empty queue is cheap and returns zero', async () => {
    assert.equal(await drainExpiredLeases(), 0);
  });

  test('the drain honours its batch ceiling', async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 30; i++) {
      await begin(ws, 'reap.cap', `cap-${i}`);
    }
    await killFleet(ws);
    // Two batches of five is ten, and no more, however much is waiting.
    const swept = await drainExpiredLeases({ batchSize: 5, maxBatches: 2 });
    assert.equal(swept, 10, `bounded drain swept ${swept}, expected exactly 10`);
    await drainExpiredLeases();
  });
});
