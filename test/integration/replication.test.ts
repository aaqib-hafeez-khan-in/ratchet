/**
 * Watching the standbys.
 *
 * A standby sat frozen for 37 minutes while every surface reported health: it
 * was streaming, its replication slot was reserved, its CPU was idle, and it
 * answered queries. It was found only because a migration added a column and
 * one node did not have it. Failing over to that node would have lost every
 * effect decided in the meantime.
 *
 * These tests pin the two judgements that came out of it — that byte distance
 * is the honest measure, and that a frozen replica is its own condition — plus
 * the rule that observing a sick cluster is not the watcher failing.
 */
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../helpers.js';

const { checkReplication, resetReplicationState } =
  await import('../../src/worker/replication.js');
const { recordOk, workerHealth } = await import('../../src/worker/heartbeat.js');

after(async () => { await closePool(); });
beforeEach(() => { resetReplicationState(); });

/** A stand-in for the cluster, so the shape of the answer can be driven. */
function fakeDb(opts: { inRecovery?: boolean; rows?: unknown[] }) {
  return {
    query: async (sql: string) => {
      if (sql.includes('pg_is_in_recovery')) {
        return { rows: [{ in_recovery: opts.inRecovery ?? false }] };
      }
      return { rows: opts.rows ?? [] };
    },
  } as never;
}

const replica = (over: Record<string, unknown> = {}) => ({
  application_name: 'standby_a', state: 'streaming',
  replay_lsn: '3/B3000000', bytes_behind: '1024', ...over,
});

describe('reading replica health', () => {
  test('a healthy streaming replica raises nothing', async () => {
    const r = await checkReplication(fakeDb({ rows: [replica()] }));
    assert.equal(r.observable, true);
    assert.deepEqual(r.problems, []);
    assert.equal(r.replicas[0]!.bytesBehind, 1024);
  });

  /**
   * The distinction that cost half an hour of undetected divergence. An idle
   * cluster reports a huge `replay_lag` in TIME because the last transaction
   * committed long ago, and a broken replica can report none at all. Distance
   * is what actually says whether a node holds the same data.
   */
  test('a replica past the byte threshold is reported', async () => {
    const far = String(400 * 1024 * 1024);
    const r = await checkReplication(fakeDb({ rows: [replica({ bytes_behind: far })] }));
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]!, /behind/);
    assert.match(r.problems[0]!, /400\.0 MB/);
  });

  test('a replica that is connected but not streaming is reported', async () => {
    const r = await checkReplication(fakeDb({ rows: [replica({ state: 'startup' })] }));
    assert.equal(r.problems.some((p) => p.includes('not streaming')), true);
  });

  /**
   * The actual incident: comfortably inside the byte threshold, streaming,
   * slot healthy — and simply not applying anything. Only successive samples
   * can see it.
   */
  test('a replica whose replay position stops moving is reported on its own', async () => {
    const db = fakeDb({ rows: [replica({ replay_lsn: '3/B3000000', bytes_behind: '2048' })] });

    const first = await checkReplication(db);
    assert.deepEqual(first.problems, [], 'one sample cannot tell frozen from slow');

    const second = await checkReplication(db);
    assert.equal(second.replicas[0]!.frozen, true);
    assert.match(second.problems[0]!, /has not replayed anything/);
  });

  test('a replica that keeps moving is never called frozen', async () => {
    await checkReplication(fakeDb({ rows: [replica({ replay_lsn: '3/B3000000' })] }));
    const second = await checkReplication(fakeDb({ rows: [replica({ replay_lsn: '3/B4000000' })] }));
    assert.equal(second.replicas[0]!.frozen, false);
    assert.deepEqual(second.problems, []);
  });

  // A caught-up replica shares the primary's position, so identical samples are
  // the normal state of a quiet cluster and must not be alarmed about.
  test('a caught-up replica is not frozen, however still it sits', async () => {
    const caught = { rows: [replica({ replay_lsn: '3/B3000000', bytes_behind: '0' })] };
    await checkReplication(fakeDb(caught));
    const second = await checkReplication(fakeDb(caught));
    assert.equal(second.replicas[0]!.frozen, false);
    assert.deepEqual(second.problems, []);
  });

  /**
   * pg_stat_replication is empty on a standby. Reading that as "no replicas,
   * all well" would make the check most confident exactly where it can see
   * least — including right after a failover.
   */
  test('from a standby it abstains rather than reporting health', async () => {
    const r = await checkReplication(fakeDb({ inRecovery: true, rows: [] }));
    assert.equal(r.observable, false);
    assert.deepEqual(r.problems, []);
  });

  /**
   * The false positive that staging caught before production saw it.
   *
   * Postgres shows the ROWS of pg_stat_replication to anyone but blanks the
   * columns for a role without pg_read_all_stats. The watcher called two
   * perfectly healthy standbys "not streaming" — and, far worse, could never
   * have seen real lag, because the position it compares was null too. A
   * monitor that invents problems gets muted, and a muted monitor is the thing
   * this file exists to prevent.
   */
  test('a role that cannot read the statistics reports blindness, not problems', async () => {
    const blanked = [
      { application_name: 'standby_a', state: null, replay_lsn: null, bytes_behind: null },
      { application_name: 'standby_b', state: null, replay_lsn: null, bytes_behind: null },
    ];
    const r = await checkReplication(fakeDb({ rows: blanked }));

    assert.equal(r.observable, false, 'it must not claim to have observed anything');
    assert.equal(r.blindReason, 'not_permitted');
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]!, /pg_read_all_stats/, 'and must say how to fix it');
    assert.equal(r.problems.some((p) => p.includes('not streaming')), false,
      'healthy replicas must never be described as broken');
  });

  test('a replica that vanishes is noticed when a count is declared', async () => {
    process.env.EXPECTED_REPLICAS = '2';
    try {
      const r = await checkReplication(fakeDb({ rows: [replica()] }));
      assert.equal(r.problems.some((p) => p.includes('1 of 2')), true);
    } finally { delete process.env.EXPECTED_REPLICAS; }
  });
});

describe('how a finding reaches an operator', () => {
  /**
   * A watcher that successfully observes a sick cluster has done its job.
   * Recording that as a loop failure would age out its heartbeat, report the
   * worker as stalled, and invite the platform to restart a process that cannot
   * fix a database.
   */
  test('a finding is carried without the loop looking stalled', async () => {
    await recordOk('replication-watch', 'test-instance', 60_000, getPool(),
      'replica standby_a is 400.0 MB behind');

    const h = await workerHealth();
    const loop = h.loops.find((l) => l.loop === 'replication-watch');
    assert.ok(loop);
    assert.equal(loop.stale, false, 'the watcher is working, so it is not stale');
    assert.equal(loop.consecutiveFailures, 0);
    assert.match(loop.lastError!, /400\.0 MB behind/);
  });

  test('a later clean check clears the finding', async () => {
    await recordOk('replication-watch', 'test-instance', 60_000, getPool(), 'something wrong');
    await recordOk('replication-watch', 'test-instance', 60_000, getPool());

    const h = await workerHealth();
    const loop = h.loops.find((l) => l.loop === 'replication-watch');
    assert.equal(loop!.lastError, null, 'a resolved problem must stop being reported');
  });
});
