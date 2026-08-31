/**
 * Bounded latency probe against the live service.
 *
 *   npx tsx scripts/prod-probe.ts [base-url]
 *
 * Deliberately small. Production is one shared-cpu-1x instance in front of a
 * 1 GB Postgres, and this repository has already caused one outage by putting
 * more load on that database than it had memory for. The point here is to learn
 * the real latency an agent sees over the network — not to find the breaking
 * point, which is not a thing worth discovering on the live system.
 *
 * It measures DUPLICATE replays rather than new effects: duplicates are not
 * metered and not billed, so the probe costs nothing and consumes no quota
 * beyond the single effect it creates to replay.
 *
 * The request budget below is deliberately under the free plan's published
 * 120/minute. Rate limiting is keyed per API key and shared across routes, so
 * every authenticated call here counts against one bucket. Exceed it and the
 * probe measures the latency of 429s — which it will then refuse to report.
 */
const BASE = process.argv[2] ?? 'https://ratchetgate.com';
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const report = (label: string, xs: number[], extra = '') =>
  console.log(`  ${label.padEnd(30)} n=${String(xs.length).padStart(4)}  ` +
    `p50=${pct(xs, 0.5).toFixed(0).padStart(4)}ms  p95=${pct(xs, 0.95).toFixed(0).padStart(4)}ms  ` +
    `p99=${pct(xs, 0.99).toFixed(0).padStart(4)}ms  max=${Math.max(...xs).toFixed(0).padStart(4)}ms ${extra}`);

async function timed(fn: () => Promise<Response>): Promise<[number, Response]> {
  const t0 = performance.now();
  const r = await fn();
  await r.arrayBuffer();
  return [performance.now() - t0, r];
}

console.log(`\nProbing ${BASE} — real network, from this machine\n`);

// One effect, created once. Everything after this is an unmetered replay.
const seed = await fetch(`${BASE}/v1/effects/begin`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ effect_type: 'probe.latency',
    idempotency_key: `probe-${Date.now()}`, payload: { probe: true } }),
});
const body = await seed.json() as any;
if (!body.workspace?.api_key) { console.error('  could not provision:', JSON.stringify(body).slice(0, 300)); process.exit(1); }
const headers = { authorization: `Bearer ${body.workspace.api_key}`, 'content-type': 'application/json' };
const replay = { effect_type: 'probe.latency', idempotency_key: body.idempotency_key, payload: { probe: true } };

const codes: Record<number, number> = {};
const note = (r: Response) => { codes[r.status] = (codes[r.status] ?? 0) + 1; };

// ---- sequential: what one agent experiences
const seq: number[] = [];
for (let i = 0; i < 30; i++) {
  const [ms, r] = await timed(() => fetch(`${BASE}/v1/effects/begin`,
    { method: 'POST', headers, body: JSON.stringify(replay) }));
  seq.push(ms); note(r);
}
report('begin (replay, sequential)', seq);

// ---- health, for a floor: how much of the above is just the link
const health: number[] = [];
for (let i = 0; i < 20; i++) {
  const [ms, r] = await timed(() => fetch(`${BASE}/healthz`));
  health.push(ms); note(r);
}
report('healthz (network floor)', health);

// ---- a read path
const reads: number[] = [];
for (let i = 0; i < 20; i++) {
  const [ms, r] = await timed(() => fetch(`${BASE}/v1/effects/${body.effect_id}`, { headers }));
  reads.push(ms); note(r);
}
report('effect read', reads);

// ---- modest concurrency: 20 at once, four rounds. Not a breaking-point test.
for (const conc of [5, 15]) {
  const lat: number[] = [];
  const t0 = Date.now();
  for (let round = 0; round < 2; round++) {
    const rs = await Promise.all(Array.from({ length: conc }, async () => {
      const [ms, r] = await timed(() => fetch(`${BASE}/v1/effects/begin`,
        { method: 'POST', headers, body: JSON.stringify(replay) }));
      note(r); return ms;
    }));
    lat.push(...rs);
  }
  report(`begin @ concurrency ${conc}`, lat,
    ` ${(lat.length / ((Date.now() - t0) / 1000)).toFixed(0)} rps`);
}

const bad = Object.entries(codes).filter(([c]) => Number(c) >= 300);
console.log(`\n  status codes: ${JSON.stringify(codes)}`);
console.log(bad.length
  ? `  NON-2xx PRESENT — the numbers above include rejections, treat them as invalid`
  : `  every request succeeded; the numbers above are the gate, not rejections`);
