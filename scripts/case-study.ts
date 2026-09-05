// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Runs the two scenarios the site claims to handle, against a live instance,
 * and prints the real transcript.
 *
 * This exists because the alternative was a case study, and we have no
 * customers to write one about. A fabricated "Acme cut duplicate charges by
 * 94%" would be inventing evidence for a product whose entire pitch is that it
 * tells you the truth about what happened. So: no story, a demonstration. Every
 * number the article quotes comes out of this script, and anyone can run it.
 *
 *   npm run case-study                      # against a local dev server
 *   BASE=https://ratchetgate.com KEY=rk_... npm run case-study
 */
const BASE = process.env.BASE ?? 'http://localhost:8787';
let KEY = process.env.KEY ?? '';

const log: string[] = [];
const say = (s = '') => { console.log(s); log.push(s); };

/**
 * Every call is checked. The first version of this script reported a failure
 * with an `error` field instead of `failure_reason`; bodies are
 * additionalProperties:false, so the API correctly returned 400 and the script
 * sailed on and published a transcript in which the payment was still pending.
 * A demonstration that does not check its own responses demonstrates nothing.
 */
async function call(
  method: string, path: string, body?: unknown,
  opts: { key?: string; expect?: number[] } = {},
) {
  const key = opts.key ?? KEY;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep the raw body */ }
  const expect = opts.expect ?? [200, 201];
  if (!expect.includes(res.status)) {
    throw new Error(
      `${method} ${path} → ${res.status}, expected ${expect.join('/')}\n${text}`);
  }
  return { status: res.status, json: json as Record<string, unknown> };
}

const show = (label: string, r: { status: number; json: unknown }) => {
  say(`${label}  →  ${r.status}`);
  say(JSON.stringify(r.json, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  say();
};

async function workspace() {
  if (KEY) return;
  const r = await call('POST', '/v1/workspaces',
    { name: `case-study-${Date.now()}`, email: `case-${Date.now()}@example.test` },
    { key: '' });
  KEY = String(r.json.api_key ?? '');
  if (!KEY) throw new Error('no api_key came back');
  say(`Workspace created. Key ends ...${KEY.slice(-6)}`);
  say();
}

/* ─────────────────────────────────────────── one: a unit of work that fails */

async function reversibleGroup() {
  say('='.repeat(72));
  say('SCENARIO 1 — five steps, the fifth one fails');
  say('='.repeat(72));
  say();

  const trip = `trip:${Date.now()}`;
  const steps = [
    { type: 'flight.book',   undo: 'flight.cancel',  key: `${trip}:flight` },
    { type: 'hotel.book',    undo: 'hotel.cancel',   key: `${trip}:hotel` },
    { type: 'seat.reserve',  undo: 'seat.release',   key: `${trip}:seat` },
    { type: 'car.book',      undo: 'car.cancel',     key: `${trip}:car` },
  ];

  const done: string[] = [];
  for (const s of steps) {
    const begun = await call('POST', '/v1/effects/begin', {
      effect_type: s.type,
      idempotency_key: s.key,
      group_key: trip,
      payload: { trip },
      compensation: { effect_type: s.undo, payload: { trip } },
    });
    const id = String(begun.json.effect_id ?? '');
    const lease = String(begun.json.lease_token ?? '');
    say(`  ${s.type.padEnd(14)} begin → ${String(begun.json.decision)}`);
    // The agent does the real work here. We say it succeeded.
    await call('POST', `/v1/effects/${id}/report`,
      { lease_token: lease, outcome: 'succeeded', result: { ok: true } });
    done.push(s.type);
  }
  say(`  4 of 5 steps done: ${done.join(', ')}`);

  // Step five: the payment fails. The agent reports the failure honestly.
  const pay = await call('POST', '/v1/effects/begin', {
    effect_type: 'payment.charge',
    idempotency_key: `${trip}:pay`,
    group_key: trip,
    payload: { trip, amount_micros: 184_20_000 },
    compensation: { effect_type: 'payment.refund', payload: { trip } },
  });
  await call('POST', `/v1/effects/${String(pay.json.effect_id)}/report`, {
    lease_token: String(pay.json.lease_token),
    outcome: 'failed', failure_reason: 'card declined by issuer',
  });
  say('  payment.charge  begin → execute, then reported FAILED');
  say();
  say('  Without a group, this is where the agent is on its own: a booked');
  say('  flight, hotel, seat and car, and no payment. Asking Ratchet instead:');
  say();

  show('POST /v1/groups/<trip>/unwind',
    await call('POST', `/v1/groups/${encodeURIComponent(trip)}/unwind`,
      { reason: 'payment declined' }));

  // The claim worth proving is that the undo is itself gated. A rollback that
  // double-refunds is the reason hand-rolled compensation is dangerous, so run
  // the first one twice, the way a crashed agent would.
  const plan = await call('GET', `/v1/groups/${encodeURIComponent(trip)}`);
  const steps2 = plan.json.steps as Array<{
    compensation: { effect_type: string }; suggested_idempotency_key: string;
  }> | undefined;
  const first = steps2?.[0];
  if (!first) throw new Error('the unwind plan came back with no steps');

  const undo = () => call('POST', '/v1/effects/begin', {
    effect_type: first.compensation.effect_type,
    idempotency_key: first.suggested_idempotency_key,
    payload: { trip },
  });
  const a = await undo();
  const b = await undo();
  say('  Running the FIRST undo twice, the way a crashed agent would:');
  say(`    ${first.compensation.effect_type} attempt 1 → ${String(a.json.decision)}`);
  say(`    ${first.compensation.effect_type} attempt 2 → ${String(b.json.decision)}`);
  say();
  return { trip, undo1: String(a.json.decision), undo2: String(b.json.decision) };
}

/* ──────────────────────────────────────── two: an agent loop that runs away */

async function surgeContainment() {
  say('='.repeat(72));
  say('SCENARIO 2 — a loop bug fires the same effect type over and over');
  say('='.repeat(72));
  say();

  const CEILING = 20;
  const ATTEMPTS = 100;

  /* A fresh workspace, and fewer attempts than the plan's requests-per-minute
     allowance. The first version of this fired 600 at once and reported that
     the ceiling had held them to 19 — but 495 of those never reached the
     ceiling at all. They were refused by the request rate limiter, which is a
     different defence entirely. The number was true and the explanation was
     wrong, which is worse than a wrong number. Keeping the burst under the
     request limit means what is measured here is surge containment alone. */
  const ws = await call('POST', '/v1/workspaces',
    { name: `surge-${Date.now()}`, email: `surge-${Date.now()}@example.test` },
    { key: '' });
  const key = String(ws.json.api_key ?? '');

  await call('PUT', '/v1/policies/payment.charge', {
    mode: 'allow', surge_per_hour: CEILING, surge_action: 'deny',
  }, { key });
  say(`  Policy: payment.charge may begin at most ${CEILING} times an hour.`);
  say(`  A buggy retry loop now attempts ${ATTEMPTS} DISTINCT charges at once.`);
  say('  Distinct, so idempotency cannot help — every one is a different charge.');
  say();

  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, (_, i) =>
      call('POST', '/v1/effects/begin', {
        effect_type: 'payment.charge',
        idempotency_key: `runaway:${t0}:${i}`,
        payload: { i },
      }, { key, expect: [200, 201, 429] })));
  const ms = Date.now() - t0;

  const tally: Record<string, number> = {};
  for (const r of results) {
    const d = r.status === 429 ? 'refused by the request rate limiter'
            : String(r.json.decision);
    tally[d] = (tally[d] ?? 0) + 1;
  }
  say(`  ${ATTEMPTS} concurrent attempts, settled in ${ms}ms:`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    say(`    ${String(v).padStart(4)}  ${k}`);
  }
  const allowed = tally.execute ?? 0;
  const rateLimited = tally['refused by the request rate limiter'] ?? 0;
  say();
  say(`  Reached the vendor: ${allowed}. Held back: ${ATTEMPTS - allowed}.`);
  if (rateLimited) {
    say(`  NOTE: ${rateLimited} never reached the ceiling — the request limiter`);
    say('  refused them first. Re-run with fewer attempts to isolate the ceiling.');
  }
  say(`  Without the ceiling, all ${ATTEMPTS} are real charges on real cards.`);
  say();
  show('GET /v1/circuits', await call('GET', '/v1/circuits', undefined, { key }));
  return { allowed, attempts: ATTEMPTS, ceiling: CEILING, ms, rateLimited };
}

const main = async () => {
  say(`Ratchet — worked scenarios, run against ${BASE}`);
  say(new Date().toISOString());
  say();
  await workspace();
  await reversibleGroup();
  const surge = await surgeContainment();
  say('='.repeat(72));
  say(`Summary: ${surge.attempts} runaway attempts, ${surge.allowed} reached the vendor.`);
  say(`The ceiling was ${surge.ceiling} an hour.`);
  say('='.repeat(72));
};

main().catch((e) => { console.error(e); process.exitCode = 1; });
