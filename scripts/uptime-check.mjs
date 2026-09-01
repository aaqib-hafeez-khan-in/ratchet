/**
 * Synthetic monitoring for Ratchet.
 *
 * "Is the port open" is not what needs watching here. The failure that hurts is
 * the SILENT one: the worker stops expiring leases, so effects sit at pending
 * for ever and every retry is answered in_flight — with the site up, the
 * database healthy, and every status page green.
 *
 * So this drives the actual product. It asks the gate for a decision and checks
 * the decision is right, which is the only thing that proves Ratchet is doing
 * its job rather than merely responding.
 *
 * COST. The idempotency key rotates daily, so exactly one metered effect is
 * created per day; every probe after the first that day is a duplicate, and
 * duplicates are free by design. Thirty gated effects a month against a free
 * allowance of a thousand.
 *
 *   RATCHET_UPTIME_KEY=rk_... node scripts/uptime-check.mjs [base-url]
 */
const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://ratchetgate.com').replace(/\/+$/, '');
const KEY = process.env.RATCHET_UPTIME_KEY;

const failures = [];
const notes = [];
const fail = (what, detail) => failures.push(`${what} — ${detail}`);
const ok = (what, detail = '') => notes.push(`  OK    ${what}${detail ? '  ' + detail : ''}`);

/** One retry: a monitor that cries wolf is a monitor nobody reads. */
async function get(path, opts = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, { ...opts, signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    } catch (e) { last = e; if (attempt === 0) await new Promise(r => setTimeout(r, 2000)); }
  }
  return { status: 0, text: String(last), json: null };
}

// ---- 1. Is the control plane serving? ---------------------------------------
for (const p of ['/healthz', '/readyz']) {
  const r = await get(p);
  r.status === 200 ? ok(p) : fail(p, `HTTP ${r.status}`);
}

// ---- 2. Is the worker actually working? -------------------------------------
// The whole reason this endpoint exists. A dead worker cannot report its own
// death, and the alert emails are delivered by that same worker.
{
  const r = await get('/workerz');
  if (r.status === 200) ok('/workerz', `${r.json?.loops ?? '?'} loops`);
  else fail('/workerz', `HTTP ${r.status} — ${r.json?.status ?? ''} ${JSON.stringify(r.json?.stalled_loops ?? '')}. `
    + 'Lease expiry may have stopped: effects will sit at pending and retries will be told in_flight.');
}

// ---- 3. Does the gate still gate? -------------------------------------------
if (!KEY) {
  fail('gate check', 'RATCHET_UPTIME_KEY is not set');
} else {
  const day = new Date().toISOString().slice(0, 10);
  const body = JSON.stringify({ effect_type: 'uptime.probe', idempotency_key: `uptime-${day}` });
  const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

  const first = await get('/v1/effects/begin', { method: 'POST', headers, body });
  if (first.status !== 200) {
    fail('gate begin', `HTTP ${first.status} ${first.text.slice(0, 160)}`);
  } else {
    const d1 = first.json?.decision;
    // First probe of the day executes; later ones are a duplicate or in flight.
    if (!['execute', 'duplicate', 'in_flight'].includes(d1)) {
      fail('gate decision', `unexpected first decision "${d1}"`);
    } else {
      ok('gate begin', `decision=${d1}`);

      // The property the product exists for: asking twice must never yield two
      // authorisations.
      const second = await get('/v1/effects/begin', { method: 'POST', headers, body });
      const d2 = second.json?.decision;
      if (second.status !== 200) {
        fail('gate replay', `HTTP ${second.status}`);
      } else if (d2 === 'execute') {
        fail('AT-MOST-ONCE VIOLATED',
          `the same idempotency key was authorised twice (${d1} then ${d2})`);
      } else if (first.json?.effect_id !== second.json?.effect_id) {
        fail('gate identity', 'the same key produced two different effect ids');
      } else {
        ok('gate replay', `decision=${d2}, same effect id`);
      }

      /*
       * Close the lease.
       *
       * This probe used to begin and walk away, which is the one thing a caller
       * must not do. The lease expired unreported, the worker correctly recorded
       * `indeterminate`, and the default policy for that state is `block` — so
       * every later probe of the same day was refused. The monitoring broke
       * itself by using the product exactly as designed, and nobody noticed for
       * five hours, because nothing yet told a person when a check failed.
       *
       * A probe that drives the real product has to drive all of it.
       */
      const lease = first.json?.lease_token;
      if (d1 === 'execute' && lease) {
        const rep = await get(`/v1/effects/${first.json.effect_id}/report`, {
          method: 'POST', headers,
          body: JSON.stringify({
            lease_token: lease, outcome: 'succeeded', result: { probe: true },
          }),
        });
        if (rep.status !== 200) fail('gate report', `HTTP ${rep.status}`);
        else ok('gate report', 'lease closed, effect settled');
      } else {
        ok('gate report', `nothing to close (decision=${d1})`);
      }
    }
  }
}

// ---- report -----------------------------------------------------------------
console.log(notes.join('\n'));
if (failures.length) {
  console.error('\nFAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
