// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * /workerz — the endpoint an uptime monitor watches.
 *
 * Separate from /readyz on purpose: /readyz decides whether this API machine
 * receives traffic, and a stalled worker must never take the control plane
 * offline. The gate works perfectly without a worker; it just stops expiring
 * leases, which is invisible until someone retries and is told `in_flight`
 * for ever.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { setupDb, getPool, closePool } from '../helpers.js';
import { recordOk } from '../../src/worker/heartbeat.js';

describe('worker liveness endpoint', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
  after(async () => { await app.close(); await closePool(); });
  beforeEach(async () => { await getPool().query('DELETE FROM worker_heartbeats'); });

  const workerz = () => app.inject({ method: 'GET', url: '/workerz' });

  test('needs no credential, so a monitor can watch it', async () => {
    const r = await workerz();
    assert.notEqual(r.statusCode, 401);
    assert.notEqual(r.statusCode, 403);
  });

  test('a worker that never started is 503, and says so distinctly', async () => {
    const r = await workerz();
    assert.equal(r.statusCode, 503);
    assert.equal(JSON.parse(r.payload).status, 'never_started');
  });

  test('a healthy worker is 200', async () => {
    await recordOk(`e2e-fresh-${Date.now()}`, 'i-1', 2000);
    const r = await workerz();
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.payload).status, 'ok');
  });

  /**
   * The uptime probe branches on this word, so it is a contract. A replica that
   * has stopped applying WAL is invisible from every other public surface —
   * that is how one stayed frozen for 37 minutes.
   */
  test('replication health is reported alongside a healthy worker', async () => {
    await recordOk('replication-watch', 'i-1', 60_000, getPool(),
      'replica standby_a is 400.0 MB behind');
    const r = await workerz();

    // Still 200: leases are expiring and the gate is correct. Failing here
    // would invite a restart of the one process that cannot fix a database.
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.status, 'ok');
    assert.equal(body.replication, 'degraded');

    // The repository is public and this endpoint takes no credential, so the
    // word travels and the detail stays in the worker's logs.
    assert.equal(r.payload.includes('standby_a'), false);
    assert.equal(r.payload.includes('400.0'), false);
  });

  test('a clean replication check reports ok', async () => {
    await recordOk('replication-watch', 'i-1', 60_000, getPool());
    const r = await workerz();
    assert.equal(JSON.parse(r.payload).replication, 'ok');
  });

  /**
   * The failure mode that would quietly undo all of this: the watcher not
   * running at all looks exactly like a healthy cluster unless it is said.
   */
  test('a missing watcher is "unobserved", never "ok"', async () => {
    await getPool().query(
      `DELETE FROM worker_heartbeats WHERE loop_name = 'replication-watch'`);
    await recordOk(`e2e-other-${Date.now()}`, 'i-1', 2000);
    const r = await workerz();
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.payload).replication, 'unobserved');
  });

  test('a stalled loop is 503 and names the loop', async () => {
    const loop = `e2e-stalled-${Date.now()}`;
    await recordOk(loop, 'i-1', 2000);
    await getPool().query(
      `UPDATE worker_heartbeats SET last_ok_at = now() - interval '1 hour'`);
    const r = await workerz();
    assert.equal(r.statusCode, 503);
    const body = JSON.parse(r.payload);
    assert.equal(body.status, 'stalled');
    assert.deepEqual(body.stalled_loops, [loop]);
    assert.match(body.detail, /leases may not be expiring/i);
  });

  test('a stalled worker does NOT take the control plane down', async () => {
    // The gate keeps working without a worker. Coupling them would turn a
    // recoverable stall into an outage.
    await recordOk(`e2e-down-${Date.now()}`, 'i-1', 2000);
    await getPool().query(
      `UPDATE worker_heartbeats SET last_ok_at = now() - interval '1 hour'`);
    assert.equal((await workerz()).statusCode, 503);
    assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  });

  test('it leaks no instance identifiers', async () => {
    await recordOk(`e2e-leak-${Date.now()}`, 'super-secret-machine-id', 2000);
    const r = await workerz();
    assert.doesNotMatch(r.payload, /super-secret-machine-id/);
  });
});
