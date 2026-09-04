// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Latency measurement for the gate. Reports real percentiles from this machine
 * against a real Postgres — no synthetic numbers appear in the docs.
 *
 *   npx tsx scripts/bench.ts [iterations]
 */
// Measure the gate, not the rate limiter: without this the numbers below are
// the latency of 429 responses once the plan limit is reached.
process.env.RATE_LIMIT_OVERRIDE = '1000000';

import { buildApp } from '../src/api/app.js';
import { createWorkspace } from '../src/domain/auth.js';
import { closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const N = Number.parseInt(process.argv[2] ?? '500', 10);

await migrate(() => {});
const app = await buildApp({ logger: false });
await app.ready();
const ws = await createWorkspace('bench', `bench-${Date.now()}@example.test`, false);
const headers = { authorization: `Bearer ${ws.key.plaintext}`, 'content-type': 'application/json' };

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const report = (label: string, xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`${label.padEnd(26)} n=${s.length}  mean=${mean.toFixed(2)}ms  ` +
    `p50=${pct(s, 0.5).toFixed(2)}  p95=${pct(s, 0.95).toFixed(2)}  p99=${pct(s, 0.99).toFixed(2)}  max=${s.at(-1)!.toFixed(2)}`);
};

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Warm the pool and JIT before measuring.
for (let i = 0; i < 50; i++) {
  await app.inject({ method: 'POST', url: '/v1/effects/begin', headers,
    payload: { effect_type: 'bench.warm', idempotency_key: `warm-${i}` } });
}

/**
 * A throttled run silently measures the latency of 429 responses instead of the
 * gate, which is exactly what happened to the first published numbers. Count
 * accepted responses and refuse to report if any were rejected.
 */
let rejected = 0;
const check = <T extends { statusCode: number }>(r: T): T => {
  if (r.statusCode === 429) rejected++;
  return r;
};

const newEffect: number[] = [];
const duplicate: number[] = [];
const reports: number[] = [];
const ids: Array<{ id: string; tok: string }> = [];

for (let i = 0; i < N; i++) {
  const payload = { effect_type: 'bench.op', idempotency_key: `bench-${i}`, payload: { i } };
  let body: any;
  newEffect.push(await timed(async () => {
    const r = check(await app.inject({ method: 'POST', url: '/v1/effects/begin', headers, payload }));
    body = JSON.parse(r.payload);
  }));
  ids.push({ id: body.effect_id, tok: body.lease_token });
}

for (const { id, tok } of ids) {
  reports.push(await timed(async () => check(await app.inject({
    method: 'POST', url: `/v1/effects/${id}/report`, headers,
    payload: { lease_token: tok, outcome: 'succeeded', result: { ok: true } },
  }))));
}

for (let i = 0; i < N; i++) {
  duplicate.push(await timed(async () => check(await app.inject({
    method: 'POST', url: '/v1/effects/begin', headers,
    payload: { effect_type: 'bench.op', idempotency_key: `bench-${i}`, payload: { i } },
  }))));
}

if (rejected > 0) {
  console.error(`\nABORT: ${rejected} request(s) were rate limited.`);
  console.error('These numbers would be the latency of 429 responses, not of the gate.');
  console.error('Set RATE_LIMIT_OVERRIDE before importing the app.');
  await app.close();
  await closePool();
  process.exit(1);
}

console.log(`\nRatchet gate latency — ${process.platform}/${process.arch}, node ${process.version}`);
console.log('in-process HTTP injection against local Postgres (excludes network RTT)\n');
report('begin (new effect)', newEffect);
report('begin (duplicate replay)', duplicate);
report('report outcome', reports);

// Throughput of the contended path: many callers racing one key.
const t0 = Date.now();
await Promise.all(Array.from({ length: 200 }, () => app.inject({
  method: 'POST', url: '/v1/effects/begin', headers,
  payload: { effect_type: 'bench.race', idempotency_key: 'one-key' },
})));
console.log(`\n200 concurrent callers on ONE key: ${Date.now() - t0}ms total`);

const t1 = Date.now();
await Promise.all(Array.from({ length: 200 }, (_, i) => app.inject({
  method: 'POST', url: '/v1/effects/begin', headers,
  payload: { effect_type: 'bench.par', idempotency_key: `par-${i}` },
})));
console.log(`200 concurrent callers on DISTINCT keys: ${Date.now() - t1}ms total`);

await app.close();
await closePool();
