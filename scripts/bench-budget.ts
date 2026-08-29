/** Measures the begin() path with budget enforcement active. */
import { buildApp } from '../src/api/app.js';
import { createWorkspace } from '../src/domain/auth.js';
import { upsertPolicy } from '../src/domain/policy.js';
import { getPool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

await migrate(() => {});
const app = await buildApp({ logger: false });
await app.ready();
const ws = await createWorkspace('bench', `b${Date.now()}@example.test`, false);
await upsertPolicy(getPool(), ws.workspaceId,
  { effectType: 'budgeted.op', dailyBudgetMicros: 100_000_000 });
const headers = { authorization: `Bearer ${ws.key.plaintext}`, 'content-type': 'application/json' };

const call = (key: string) => app.inject({
  method: 'POST', url: '/v1/effects/begin', headers,
  payload: { effect_type: 'budgeted.op', idempotency_key: key, estimated_cost_micros: 100 },
});

for (let i = 0; i < 50; i++) await call(`warm-${i}`);

const xs: number[] = [];
for (let i = 0; i < 400; i++) {
  const t = process.hrtime.bigint();
  await call(`bench-${i}`);
  xs.push(Number(process.hrtime.bigint() - t) / 1e6);
}
xs.sort((a, b) => a - b);
const p = (q: number) => xs[Math.floor(xs.length * q)]!.toFixed(2);
console.log(`begin (new, budget enforced)  n=${xs.length}  ` +
  `mean=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)}ms  ` +
  `p50=${p(0.5)}  p95=${p(0.95)}  p99=${p(0.99)}`);

await app.close();
await closePool();
