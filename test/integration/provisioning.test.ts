/**
 * The only place a stranger can obtain something of value without presenting
 * anything, so it is the only place worth attacking for profit.
 *
 * The measured exposure before this: 20 workspaces an hour from one address, at
 * 100 gated effects each, in an in-memory counter that was per instance and
 * reset on deploy. That is 2,000 free gated effects an hour per address per
 * instance, against a free PLAN of 1,000 a month.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// These are read once at module load, and helpers transitively imports config —
// so a STATIC import of helpers would freeze the suite-wide 100000 before these
// assignments ran. The first version did exactly that and the ceiling test
// looped a hundred thousand times, taking eight minutes to pass for the wrong
// reason. Everything below is imported dynamically, after the environment is
// settled, the same way limits.test.ts does it.
process.env.PROVISION_PER_SOURCE_PER_HOUR = '5';
process.env.PROVISION_GLOBAL_PER_HOUR = '40';

const { closePool, getPool } = await import('../helpers.js');
const { config } = await import('../../src/lib/config.js');
const {
  claimProvisionSlot, provisionPressure, gcProvisionWindows, sourceHash,
} = await import('../../src/domain/provisioning.js');

after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM provision_windows');
  await getPool().query('DELETE FROM provision_global');
});

const claim = (ip: string) => claimProvisionSlot(ip);

describe('the per-source ceiling', () => {
  test('allows exactly the configured number and then refuses', async () => {
    const limit = config.provisionPerSourcePerHour;
    const outcomes = [];
    for (let i = 0; i < limit + 4; i++) outcomes.push(await claim('198.51.100.10'));

    assert.equal(outcomes.filter((o) => o.allowed).length, limit);
    const refused = outcomes.filter((o) => !o.allowed);
    assert.ok(refused.every((o) => !o.allowed && o.scope === 'source'));
  });

  test('one address exhausting its ration does not touch another', async () => {
    for (let i = 0; i < config.provisionPerSourcePerHour; i++) await claim('198.51.100.10');
    const other = await claim('198.51.100.11');
    assert.equal(other.allowed, true, 'a different caller is unaffected');
  });

  test('holds under a concurrent burst, not just a sequential loop', async () => {
    const limit = config.provisionPerSourcePerHour;
    const results = await Promise.all(
      Array.from({ length: limit * 8 }, () => claim('203.0.113.5')));
    const allowed = results.filter((r) => r.allowed).length;
    assert.equal(allowed, limit,
      `a read-then-increment ceiling leaks here; got ${allowed}, expected ${limit}`);
  });

  // The counter has to be in the database, not the process. In memory it was
  // per instance and reset on deploy, so the published number was fiction.
  test('the count is durable, so a restart does not hand out a fresh ration', async () => {
    await claim('203.0.113.9');
    const { rows } = await getPool().query<{ count: number }>(
      'SELECT count FROM provision_windows WHERE source_hash = $1',
      [sourceHash('203.0.113.9')]);
    assert.equal(rows[0]?.count, 1,
      'nothing survives a deploy unless it is written down');
  });

  test('the address itself is never stored', async () => {
    await claim('198.51.100.77');
    const { rows } = await getPool().query<{ source_hash: string }>(
      'SELECT source_hash FROM provision_windows');
    assert.ok(rows.length);
    for (const r of rows) {
      assert.doesNotMatch(r.source_hash, /198\.51\.100\.77/,
        'we count repeat callers without keeping a log of who visited');
    }
  });
});

describe('the global ceiling', () => {
  // Per-source is close to decorative against anyone deliberate: an address is
  // the cheapest thing on the internet to rotate. This is the one that holds.
  test('survives address rotation, which per-source does not', async () => {
    const ceiling = config.provisionGlobalPerHour;
    let allowed = 0;
    // A fresh address every single time — per-source never fires.
    for (let i = 0; i < ceiling + 30; i++) {
      const r = await claim(`10.0.${Math.floor(i / 254)}.${(i % 254) + 1}`);
      if (r.allowed) allowed++;
    }
    assert.equal(allowed, ceiling,
      'rotating addresses must not buy more than the global ration');
  });

  test('refusal names the global scope, so the message can differ', async () => {
    const ceiling = config.provisionGlobalPerHour;
    for (let i = 0; i < ceiling; i++) await claim(`10.1.${Math.floor(i / 254)}.${(i % 254) + 1}`);
    const next = await claim('10.9.9.9');
    assert.equal(next.allowed, false);
    assert.ok(!next.allowed && next.scope === 'global');
  });

  test('pressure is observable before it becomes a refusal', async () => {
    await claim('192.0.2.1');
    await claim('192.0.2.2');
    const p = await provisionPressure();
    assert.equal(p.thisHour, 2);
    assert.equal(p.sources, 2);
    assert.equal(p.ceiling, config.provisionGlobalPerHour);
    assert.equal(p.atCeiling, false);
  });
});

describe('housekeeping', () => {
  test('spent windows are collected rather than growing forever', async () => {
    await getPool().query(
      `INSERT INTO provision_windows (source_hash, hour_start, count)
       VALUES ('old', now() - interval '9 hours', 3)`);
    await claim('192.0.2.50');

    assert.ok(await gcProvisionWindows() >= 1);
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM provision_windows');
    assert.equal(Number(rows[0]?.n), 1, 'the current hour survives');
  });
});
