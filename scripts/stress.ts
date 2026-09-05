// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Stress and failure simulation for the gate.
 *
 *   npx tsx scripts/stress.ts [scale]
 *
 * Two things are being asked here, and they are not the same question:
 *
 *   1. How fast is it, and how does that degrade with concurrency?
 *   2. Do the safety properties still hold when it is under pressure?
 *
 * The second matters far more. A gate that is fast but admits two `execute`
 * decisions for one key under load has failed at the only thing it does. Every
 * simulation below is written so that the WRONG answer is loud, and none of
 * them pass by default — each asserts a specific number.
 *
 * Runs in-process against a real Postgres. That excludes network RTT, which is
 * deliberate: it isolates the gate's own cost from the caller's link.
 */
process.env.RATE_LIMIT_OVERRIDE = '10000000';

import { buildApp } from '../src/api/app.js';
import { createWorkspace } from '../src/domain/auth.js';
import { getPool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { sweepExpiredLeases } from '../src/worker/reaper.js';

const SCALE = Number.parseInt(process.argv[2] ?? '1', 10);
const app = await buildApp({ logger: false });
await migrate(() => {});
await app.ready();

let failures = 0;
const results: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  const line = `  [${mark}] ${label.padEnd(46)} ${detail}`;
  console.log(line);
  results.push(line);
}

async function workspace(name: string, { funded = true } = {}) {
  const ws = await createWorkspace(name, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}@stress.test`, false);
  // Fund it unless a simulation is specifically about running out. A load test
  // against an exhausted workspace measures the latency of 402s, which is the
  // same trap scripts/bench.ts guards against with rate limiting.
  if (funded) {
    await getPool().query(
      `UPDATE workspaces SET plan = 'scale', credit_micros = 100000000000 WHERE id = $1`,
      [ws.workspaceId]);
  }
  return {
    id: ws.workspaceId,
    headers: { authorization: `Bearer ${ws.key.plaintext}`, 'content-type': 'application/json' },
  };
}

/**
 * Sweep until there is nothing left to sweep.
 *
 * sweepExpiredLeases takes the OLDEST 50, so a single call in a database with a
 * backlog will never reach the effect a simulation just created. Draining also
 * measures the real throughput of the transition, which is a capacity number
 * worth knowing: the worker gets one batch per tick and no more.
 */
async function drainLeases(): Promise<{ swept: number; batches: number; ms: number }> {
  const t0 = Date.now();
  let swept = 0, batches = 0, n = 0;
  do { n = await sweepExpiredLeases(); swept += n; batches++; } while (n > 0 && batches < 2000);
  return { swept, batches, ms: Date.now() - t0 };
}

const post = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'POST', url, headers, payload: payload as object });
const put = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers, payload: payload as object });

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};

// ───────────────────────────────────────────── 1. latency under concurrency
console.log('\n1. LATENCY UNDER CONCURRENCY  (distinct keys — the uncontended path)\n');
{
  const ws = await workspace('load');
  for (const conc of [1, 8, 32, 128, 256]) {
    const n = conc * 4 * SCALE;
    const lat: number[] = [];
    const codes: Record<number, number> = {};
    const t0 = Date.now();
    let issued = 0;
    await Promise.all(Array.from({ length: conc }, async () => {
      while (issued < n) {
        const i = issued++;
        const s = process.hrtime.bigint();
        const r = await post('/v1/effects/begin', ws.headers,
          { effect_type: 'stress.load', idempotency_key: `c${conc}-${i}` });
        lat.push(Number(process.hrtime.bigint() - s) / 1e6);
        codes[r.statusCode] = (codes[r.statusCode] ?? 0) + 1;
      }
    }));
    const secs = (Date.now() - t0) / 1000;
    const bad = Object.entries(codes).filter(([c]) => c !== '200');
    if (bad.length) {
      // Refuse to print a percentile derived from rejections. A row of fast
      // 402s reads as excellent throughput and means the opposite.
      console.log(`  conc=${String(conc).padStart(3)}  n=${String(n).padStart(5)}  ` +
        `UNUSABLE — ${JSON.stringify(codes)} (measuring rejections, not the gate)`);
      failures++;
      continue;
    }
    console.log(`  conc=${String(conc).padStart(3)}  n=${String(n).padStart(5)}  ` +
      `p50=${pct(lat, 0.5).toFixed(1).padStart(6)}ms  p95=${pct(lat, 0.95).toFixed(1).padStart(6)}ms  ` +
      `p99=${pct(lat, 0.99).toFixed(1).padStart(6)}ms  ${(n / secs).toFixed(0).padStart(5)} rps`);
  }
}

// ───────────────────────────────────────── 2. the duplicate storm (the point)
console.log('\n2. SAFETY UNDER LOAD\n');
{
  const ws = await workspace('storm');
  const N = 500 * SCALE;
  const rs = await Promise.all(Array.from({ length: N }, () =>
    post('/v1/effects/begin', ws.headers,
      { effect_type: 'stress.storm', idempotency_key: 'the-one-key', payload: { v: 1 } })));
  const bodies = rs.map((r) => JSON.parse(r.payload));
  const executes = bodies.filter((b) => b.decision === 'execute');
  const ids = new Set(bodies.map((b) => b.effect_id).filter(Boolean));
  const leases = new Set(bodies.map((b) => b.lease_token).filter(Boolean));
  check('duplicate storm: exactly one execute', executes.length === 1,
    `${N} concurrent callers, one key → ${executes.length} execute`);
  check('duplicate storm: one effect record', ids.size === 1,
    `${ids.size} distinct effect id(s)`);
  check('duplicate storm: one live lease', leases.size === 1,
    `${leases.size} distinct lease token(s)`);
  const vendorKeys = new Set(bodies.map((b) => b.vendor_idempotency_key?.key).filter(Boolean));
  check('duplicate storm: one vendor idempotency key', vendorKeys.size === 1,
    `${vendorKeys.size} distinct vendor key(s)`);
}

// ─────────────────────────────────────────── 3. budget ceiling under racing
{
  const ws = await workspace('budget');
  const CEILING = 100_000;          // micro-USD
  const COST = 1_000;
  await put('/v1/policies/stress.spend', ws.headers,
    { mode: 'allow', daily_budget_micros: CEILING, require_cost: true });
  const N = 400 * SCALE;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) =>
    post('/v1/effects/begin', ws.headers,
      { effect_type: 'stress.spend', idempotency_key: `spend-${i}`, estimated_cost_micros: COST })));
  const allowed = rs.filter((r) => JSON.parse(r.payload).decision === 'execute').length;
  const spent = allowed * COST;
  check('spend ceiling holds under concurrency', spent <= CEILING,
    `${N} racing callers × ${COST} → ${spent} spent, ceiling ${CEILING}`);
  check('ceiling is actually reached (not under-admitting)', allowed >= CEILING / COST,
    `${allowed} admitted, ceiling allows ${CEILING / COST}`);
}

// ───────────────────────────────────────────────────── 4. fencing tokens
{
  const ws = await workspace('fence');
  const first = JSON.parse((await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.fence', idempotency_key: 'fence-1' })).payload);
  const staleToken = first.lease_token;
  await getPool().query(
    `UPDATE effects SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [first.effect_id]);
  await drainLeases();
  await put('/v1/policies/stress.fence', ws.headers, { mode: 'allow', on_indeterminate: 'retry' });
  const second = JSON.parse((await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.fence', idempotency_key: 'fence-1' })).payload);
  const stale = await post(`/v1/effects/${first.effect_id}/report`, ws.headers,
    { lease_token: staleToken, outcome: 'succeeded', result: { by: 'the zombie' } });
  check('a stale lease token cannot report', stale.statusCode >= 400,
    `zombie report → HTTP ${stale.statusCode}`);
  check('the new attempt holds a different token', second.lease_token !== staleToken,
    `attempt ${second.attempt}, token rotated: ${second.lease_token !== staleToken}`);
}

// ──────────────────────────────────────── 5. crash mid-effect → indeterminate
{
  const ws = await workspace('crash');
  const b = JSON.parse((await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.crash', idempotency_key: 'crash-1' })).payload);
  await getPool().query(
    `UPDATE effects SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [b.effect_id]);
  await drainLeases();
  const { rows } = await getPool().query('SELECT state FROM effects WHERE id = $1', [b.effect_id]);
  check('an abandoned lease becomes indeterminate', rows[0]?.state === 'indeterminate',
    `state after sweep: ${rows[0]?.state}`);
  const after = JSON.parse((await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.crash', idempotency_key: 'crash-1' })).payload);
  check('default policy refuses to auto-retry an unknown outcome',
    after.decision !== 'execute',
    `decision on retry after indeterminate: ${after.decision}`);
}

// ───────────────────────────────────────── 6. key reuse with a different payload
{
  const ws = await workspace('mismatch');
  await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.mismatch', idempotency_key: 'm-1', payload: { to: 'alice', amount: 10 } });
  const bad = await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.mismatch', idempotency_key: 'm-1', payload: { to: 'mallory', amount: 9999 } });
  check('same key, different payload is refused', bad.statusCode >= 400,
    `→ HTTP ${bad.statusCode} ${JSON.parse(bad.payload).error?.code ?? ''}`);
}

// ─────────────────────────────────────────── 7. tenant isolation under load
{
  const a = await workspace('tenant-a');
  const b = await workspace('tenant-b');
  const mine = JSON.parse((await post('/v1/effects/begin', a.headers,
    { effect_type: 'stress.iso', idempotency_key: 'secret-work' })).payload);
  const probes = await Promise.all(Array.from({ length: 100 * SCALE }, () =>
    app.inject({ method: 'GET', url: `/v1/effects/${mine.effect_id}`, headers: b.headers })));
  const leaked = probes.filter((r) => r.statusCode !== 404).length;
  check('cross-tenant reads never succeed under load', leaked === 0,
    `${probes.length} probes → ${leaked} non-404`);
  // The neighbour must also not be able to seize the same logical effect.
  const collide = JSON.parse((await post('/v1/effects/begin', b.headers,
    { effect_type: 'stress.iso', idempotency_key: 'secret-work' })).payload);
  check('an identical key in another tenant is independent',
    collide.decision === 'execute' && collide.effect_id !== mine.effect_id,
    `neighbour got ${collide.decision}, distinct record: ${collide.effect_id !== mine.effect_id}`);
}

// ──────────────────────────────────────── 8. mixed workload / deadlock hunt
{
  const ws = await workspace('mixed');
  await put('/v1/policies/stress.mixed', ws.headers,
    { mode: 'allow', daily_budget_micros: 10_000_000, require_cost: true });
  const N = 300 * SCALE;
  const errs: string[] = [];
  const ops = Array.from({ length: N }, (_, i) => async () => {
    const r = await post('/v1/effects/begin', ws.headers,
      { effect_type: 'stress.mixed', idempotency_key: `mix-${i}`, estimated_cost_micros: 100 });
    if (r.statusCode !== 200) { errs.push(`begin ${r.statusCode}: ${r.payload.slice(0, 120)}`); return; }
    const b = JSON.parse(r.payload);
    if (b.decision !== 'execute') return;
    const rep = await post(`/v1/effects/${b.effect_id}/report`, ws.headers,
      { lease_token: b.lease_token, outcome: i % 7 === 0 ? 'failed' : 'succeeded',
        ...(i % 7 === 0 ? { failure_reason: 'simulated' } : { result: { i } }) });
    if (rep.statusCode !== 200) errs.push(`report ${rep.statusCode}: ${rep.payload.slice(0, 120)}`);
  });
  const t0 = Date.now();
  await Promise.all(ops.map((f) => f()));
  const secs = (Date.now() - t0) / 1000;
  const deadlocks = errs.filter((e) => /deadlock/i.test(e)).length;
  check('mixed begin+report workload: no deadlocks', deadlocks === 0,
    `${N} interleaved ops in ${secs.toFixed(2)}s → ${deadlocks} deadlock(s)`);
  check('mixed workload: no unexpected errors', errs.length === 0,
    errs.length ? `${errs.length} error(s), first: ${errs[0]}` : 'clean');
}

// ─────────────────────────────────────── 9. replay is stable forever
{
  const ws = await workspace('replay');
  const b = JSON.parse((await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.replay', idempotency_key: 'r-1' })).payload);
  await post(`/v1/effects/${b.effect_id}/report`, ws.headers,
    { lease_token: b.lease_token, outcome: 'succeeded', result: { charge: 'ch_123' } });
  const replays = await Promise.all(Array.from({ length: 200 * SCALE }, () =>
    post('/v1/effects/begin', ws.headers,
      { effect_type: 'stress.replay', idempotency_key: 'r-1' })));
  const bodies = replays.map((r) => JSON.parse(r.payload));
  const decisions = new Set(bodies.map((b) => b.decision));
  const payloads = new Set(bodies.map((b) => JSON.stringify(b.result)));
  check('a succeeded effect replays one stable result',
    decisions.size === 1 && [...decisions][0] === 'duplicate' && payloads.size === 1,
    `${bodies.length} replays → decisions ${[...decisions]}, ${payloads.size} distinct result(s)`);
}

// ─────────────────────────────────────────────────────── 10. pool pressure
{
  const ws = await workspace('pool');
  const { rows: before } = await getPool().query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`);
  const burst = 600 * SCALE;
  const rs = await Promise.all(Array.from({ length: burst }, (_, i) =>
    post('/v1/effects/begin', ws.headers,
      { effect_type: 'stress.pool', idempotency_key: `pool-${i}` })));
  const { rows: after } = await getPool().query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`);
  const errors = rs.filter((r) => r.statusCode !== 200);
  check('a burst larger than the pool queues rather than failing', errors.length === 0,
    `${burst} simultaneous requests → ${errors.length} error(s); ` +
    `connections ${before[0].n} → ${after[0].n}`);
}

// ────────────────────────────── 11. how fast can an abandoned fleet resolve?
{
  const ws = await workspace('reap');
  const N = 500 * SCALE;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) =>
    post('/v1/effects/begin', ws.headers,
      { effect_type: 'stress.reap', idempotency_key: `reap-${i}` })));
  const started = rs.filter((r) => r.statusCode === 200).length;
  // Every agent dies at once, holding its lease.
  await getPool().query(
    `UPDATE effects SET lease_expires_at = now() - interval '1 second'
      WHERE workspace_id = $1 AND state = 'pending'`, [ws.id]);
  const d = await drainLeases();
  const perSec = d.swept / (d.ms / 1000);
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM effects WHERE workspace_id = $1 AND state = 'indeterminate'`,
    [ws.id]);
  check('every abandoned lease resolves to indeterminate', rows[0].n === started,
    `${started} abandoned → ${rows[0].n} indeterminate`);
  console.log(`\n  reaper drain: ${d.swept} leases in ${d.batches} batches, ` +
    `${d.ms}ms  →  ${perSec.toFixed(0)}/s when draining continuously`);
  const tick = Number(process.env.LEASE_SWEEP_INTERVAL_MS ?? 2000);
  const perTick = 40 * 50;   // drainExpiredLeases: maxBatches × batchSize
  console.log(`  worker cadence: drains up to ${perTick} per ${tick}ms tick ` +
    `= ${Math.round(perTick / (tick / 1000))}/s sustained, so this burst clears in ` +
    `~${Math.max(1, Math.ceil(started / perTick))} tick(s).`);
}

// ────────────────────────── 12. surge containment under a real stampede
{
  const ws = await workspace('surge');
  const CEILING = 20;
  await put('/v1/policies/stress.surge', ws.headers,
    { mode: 'allow', surge_per_hour: CEILING, surge_action: 'deny' });

  // Every caller arrives at once — the worst case for a counter-based control.
  const N = 300 * SCALE;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) =>
    post('/v1/effects/begin', ws.headers,
      { effect_type: 'stress.surge', idempotency_key: `surge-${i}` })));
  const bodies = rs.map((r) => JSON.parse(r.payload));
  const executed = bodies.filter((b) => b.decision === 'execute').length;
  const denied = bodies.filter((b) => b.decision === 'denied').length;

  check('a surge is contained even when it arrives all at once',
    executed <= CEILING + 5 && denied > 0,
    `${N} simultaneous callers, ceiling ${CEILING} → ${executed} executed, ${denied} denied`);

  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM circuit_breakers
      WHERE workspace_id = $1 AND effect_type = 'stress.surge'`, [ws.id]);
  check('a stampede opens exactly one breaker, not many', rows[0].n === 1,
    `${rows[0].n} breaker row(s)`);

  // Containment must not leak into a type nobody configured.
  const other = JSON.parse((await post('/v1/effects/begin', ws.headers,
    { effect_type: 'stress.unrelated', idempotency_key: 'unrelated-1' })).payload);
  check('an open breaker does not stop unrelated effect types',
    other.decision === 'execute', `unrelated type got ${other.decision}`);
}

console.log(`\n${failures === 0 ? 'ALL SAFETY PROPERTIES HELD' : `${failures} SAFETY CHECK(S) FAILED`}\n`);
await app.close();
await closePool();
process.exit(failures === 0 ? 0 : 1);
