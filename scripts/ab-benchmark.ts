/**
 * The same job, run twice: once without the gate and once with it.
 *
 * Everything about a product like this is a counterfactual — the charge that
 * did not happen. You cannot see it, which is why the honest way to make the
 * claim is to run the job both ways and count what a third party received.
 *
 * THE SETUP. A local "vendor" stands in for a payments API. It records every
 * request it actually executes, and that record is the ground truth: not what
 * the agent believes, not what Ratchet says, but what the outside world did.
 *
 * THE FAILURE BEING SIMULATED is the one that matters and the one people
 * under-model: the request ARRIVES, the vendor EXECUTES it, and the response is
 * lost on the way back. The caller sees a timeout and cannot distinguish it
 * from a request that never landed. Retrying is correct behaviour and also the
 * thing that charges the customer twice.
 *
 * FAIRNESS. Both runs use the same agent logic, the same job, and the same
 * seeded failure sequence — request #3 loses its response in run A and in run
 * B. Without that the comparison would be measuring luck.
 *
 * READ THE LATENCY NUMBERS CAREFULLY. Run from a laptop, this measures your
 * network far more than it measures the gate. Measured 2 Sep 2026:
 *
 *                        from a laptop        from inside the datacentre
 *   GET /healthz         p50  37ms            p50   3ms
 *   begin (new)          p50 184ms  p95 1679  p50  26ms  p95 98ms
 *   begin (replay)       p50 305ms  p95 1164  p50  13ms  p95 32ms
 *
 * Two things that reading corrects. Replay looked SLOWER than a new effect from
 * the laptop, which is backwards and was pure noise — served locally it is half
 * the cost, as it should be. And the p95 above one second is TLS and the public
 * internet, not the gate: the same box answers /healthz in 3ms.
 *
 * So the honest statement of cost is "about 25ms of server time, plus whatever
 * your round trip to us is". An agent in the same region pays the first number.
 * One on a laptop pays mostly the second.
 *
 * The CORRECTNESS result is unaffected by any of this and is identical across
 * runs, because the failure sequence is seeded.
 *
 *   npx tsx scripts/ab-benchmark.ts [--jobs 40] [--base https://ratchetgate.com]
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const JOBS = Number(arg('jobs', '40'));
const BASE = arg('base', 'https://ratchetgate.com').replace(/\/+$/, '');
const REFUND_CENTS = 24_000;              // $240.00, the site's own example
const LOSS_RATE = 0.25;                   // 1 in 4 responses lost in flight
const MAX_RETRIES = 3;

/** Deterministic PRNG so both runs meet identical failures. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ---------------------------------------------------------------- the vendor
interface Vendor {
  server: Server; port: number;
  executed: string[];                     // every refund the vendor actually performed
  reset(): void; close(): Promise<void>;
}

async function startVendor(): Promise<Vendor> {
  const executed: string[] = [];
  let rng = seeded(1);

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { customer } = JSON.parse(body || '{}');
      // The vendor ALWAYS performs the work. That is the point: the failure is
      // in the reply, not the action.
      executed.push(customer);
      if (rng() < LOSS_RATE) {
        // Response lost. The socket dies with the work already done.
        req.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, refunded: REFUND_CENTS }));
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    server, port, executed,
    reset() { executed.length = 0; rng = seeded(1); },
    async close() { await new Promise<void>((r) => server.close(() => r())); },
  };
}

const callVendor = async (port: number, customer: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer, amount: REFUND_CENTS }),
    signal: AbortSignal.timeout(4_000),
  });
  return res.json();
};

// ---------------------------------------------------------------- the gate
async function provision(): Promise<string> {
  const res = await fetch(`${BASE}/v1/workspaces`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `ab-bench-${Date.now()}`, email: `ab-bench-${Date.now()}@example.test` }),
  });
  if (!res.ok) throw new Error(`could not provision a workspace: HTTP ${res.status}`);
  const d = await res.json() as { api_key?: { plaintext?: string } | string };
  const k = d.api_key;
  const key = typeof k === 'string' ? k : k?.plaintext;
  if (!key) throw new Error('no api key in the signup response');
  return key;
}

const gateLatency: number[] = [];

async function askGate(key: string, idemKey: string): Promise<string> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1/effects/begin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      effect_type: 'payment.refund',
      idempotency_key: idemKey,
      payload: { amount_cents: REFUND_CENTS },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  gateLatency.push(performance.now() - t0);
  if (!res.ok) throw new Error(`begin failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json() as { decision: string }).decision;
}

async function reportGate(key: string, idemKey: string, ok: boolean) {
  await fetch(`${BASE}/v1/effects/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      effect_type: 'payment.refund', idempotency_key: idemKey,
      outcome: ok ? 'succeeded' : 'failed',
      ...(ok ? { result: { refunded: true } } : { failure_reason: 'response lost in flight' }),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

// ---------------------------------------------------------------- the agent
interface Run { label: string; ms: number; attempts: number; gateCalls: number }

async function runJob(
  vendor: Vendor, customers: string[], gate: { key: string; run: string } | null,
): Promise<Run> {
  vendor.reset();
  const t0 = performance.now();
  let attempts = 0, gateCalls = 0;

  for (const customer of customers) {
    const idemKey = gate ? `${gate.run}:${customer}` : '';

    for (let tryN = 0; tryN <= MAX_RETRIES; tryN++) {
      // WITH the gate: ask first, and obey the answer.
      if (gate) {
        gateCalls++;
        const decision = await askGate(gate.key, idemKey);
        if (decision !== 'execute') break;   // duplicate / in_flight / blocked — stop
      }

      attempts++;
      try {
        await callVendor(vendor.port, customer);
        if (gate) await reportGate(gate.key, idemKey, true);
        break;                                // succeeded, move on
      } catch {
        // A timeout. The agent cannot tell whether the refund happened, and a
        // well-built agent retries — which is exactly the problem.
        if (gate) await reportGate(gate.key, idemKey, false);
        if (tryN === MAX_RETRIES) break;
      }
    }
  }
  return { label: gate ? 'with Ratchet' : 'without Ratchet',
           ms: performance.now() - t0, attempts, gateCalls };
}

// ---------------------------------------------------------------- report
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function summarise(label: string, executed: string[], run: Run) {
  const unique = new Set(executed).size;
  const dupes = executed.length - unique;
  console.log(`\n  ${label}`);
  console.log(`    refunds the vendor actually performed   ${executed.length}`);
  console.log(`    distinct customers refunded             ${unique}`);
  console.log(`    DUPLICATE refunds                       ${dupes}`);
  console.log(`    money moved                             ${money(executed.length * REFUND_CENTS)}`);
  console.log(`    money that should have moved            ${money(unique * REFUND_CENTS)}`);
  console.log(`    overpaid                                ${money(dupes * REFUND_CENTS)}`);
  console.log(`    wall clock                              ${(run.ms / 1000).toFixed(1)}s`);
  return { executed: executed.length, unique, dupes, ms: run.ms };
}

// ---------------------------------------------------------------- main
const vendor = await startVendor();
const customers = Array.from({ length: JOBS }, (_, i) => `cust_${String(i + 1).padStart(4, '0')}`);

console.log(`\n  ${JOBS} refunds of ${money(REFUND_CENTS)}, `
  + `${Math.round(LOSS_RATE * 100)}% of responses lost in flight, up to ${MAX_RETRIES} retries.`);
console.log(`  Gate: ${BASE}`);

const a = await runJob(vendor, customers, null);
const without = summarise('WITHOUT the gate', [...vendor.executed], a);

const key = await provision();
const b = await runJob(vendor, customers, { key, run: randomUUID().slice(0, 8) });
const with_ = summarise('WITH the gate', [...vendor.executed], b);

console.log(`\n  ── the difference ──`);
console.log(`    duplicate refunds prevented             ${without.dupes - with_.dupes}`);
console.log(`    money not lost                          ${money((without.dupes - with_.dupes) * REFUND_CENTS)}`);
console.log(`    gate calls made                         ${b.gateCalls}`);
console.log(`    gate latency  p50 ${pct(gateLatency, 0.5).toFixed(0)}ms  `
  + `p95 ${pct(gateLatency, 0.95).toFixed(0)}ms  max ${Math.max(...gateLatency).toFixed(0)}ms`);
console.log(`    added wall clock                        `
  + `${((with_.ms - without.ms) / 1000).toFixed(1)}s over ${JOBS} jobs`);
console.log(`    cost of the gate                        `
  + `${((with_.ms - without.ms) / JOBS).toFixed(0)}ms per job\n`);

await vendor.close();
process.exit(0);
