// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * The gate that a deploy has to get through.
 *
 * The uptime probe watches production and needs a stored credential to do it.
 * This is for staging, where a stored credential is the wrong shape: the whole
 * point is that a freshly deployed instance is exercised from nothing, the way
 * a new user meets it. So it provisions its own workspace through the keyless
 * path and then drives the real lifecycle with it.
 *
 * What it proves, in order of what has actually broken before:
 *
 *   The process boots and connects to ITS OWN database. A staging app pointed
 *   at production is the failure this environment exists to prevent, so the
 *   workspace it creates must not be visible anywhere else.
 *
 *   Migrations ran. A begin against a missing table fails here rather than in
 *   front of a customer.
 *
 *   The gate decides correctly: execute, then duplicate for the same key, and a
 *   recorded outcome that replays. That is the product's entire claim.
 *
 *   Nothing indexable escaped. Staging serves a copy of the marketing site, and
 *   a search result pointing at a half-tested build is a real cost.
 *
 *   npm run smoke:staging
 */
const BASE = (process.env.BASE ?? 'https://ratchet-gate-staging.fly.dev').replace(/\/+$/, '');

const failures = [];
const fail = (what, detail) => failures.push(`${what} — ${detail}`);
const ok = (what, detail = '') => console.log(`  OK    ${what}${detail ? `  ${detail}` : ''}`);

const req = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};

/* ---- it is up ---------------------------------------------------------- */
for (const path of ['/healthz', '/readyz', '/workerz']) {
  const r = await req(path);
  if (r.status !== 200) fail(path, `HTTP ${r.status}`);
  else ok(path, path === '/workerz' ? `${r.json?.loops ?? '?'} loops` : '');
}

/* ---- it is not the real site ------------------------------------------- */
// Only meaningful against staging: production is supposed to be indexable, and
// asserting this everywhere made a healthy production run report a failure —
// which is a good way to teach yourself to ignore your own smoke test.
if (/staging/.test(BASE)) {
  const home = await req('/');
  const tag = home.headers.get('x-robots-tag') ?? '';
  if (!/noindex/.test(tag)) {
    fail('noindex', `staging must not be indexable; X-Robots-Tag was "${tag || '(absent)'}"`);
  } else {
    ok('noindex', tag);
  }
}

/* ---- the gate actually gates ------------------------------------------- */
const key = `smoke:${Date.now()}`;
const first = await req('/v1/effects/begin', {
  method: 'POST',
  body: JSON.stringify({ effect_type: 'smoke.test', idempotency_key: key, payload: {} }),
});

if (first.status !== 200) {
  fail('provision + begin', `HTTP ${first.status} ${first.text.slice(0, 160)}`);
} else if (first.json?.decision !== 'execute') {
  fail('begin', `expected "execute", got "${first.json?.decision}"`);
} else {
  const apiKey = first.json.workspace?.api_key;
  if (!apiKey) {
    fail('keyless provisioning', 'no workspace came back with the decision');
  } else {
    ok('provision + begin', `decision=execute, workspace=${first.json.workspace.workspace_id}`);
    const auth = { authorization: `Bearer ${apiKey}` };

    // Asking twice must never authorise twice. This is the product.
    const second = await req('/v1/effects/begin', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ effect_type: 'smoke.test', idempotency_key: key, payload: {} }),
    });
    if (second.json?.decision === 'execute') {
      fail('AT-MOST-ONCE VIOLATED', 'the same key was authorised twice');
    } else if (second.json?.effect_id !== first.json.effect_id) {
      fail('identity', 'the same key produced two different effect ids');
    } else {
      ok('replay', `decision=${second.json.decision}, same effect id`);
    }

    // Close the lease, then confirm the outcome is replayed rather than rerun.
    const reported = await req(`/v1/effects/${first.json.effect_id}/report`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        lease_token: first.json.lease_token, outcome: 'succeeded', result: { smoke: true },
      }),
    });
    if (reported.status !== 200) {
      fail('report', `HTTP ${reported.status} ${reported.text.slice(0, 160)}`);
    } else {
      const third = await req('/v1/effects/begin', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ effect_type: 'smoke.test', idempotency_key: key, payload: {} }),
      });
      if (third.json?.decision !== 'duplicate') {
        fail('replay after report', `expected "duplicate", got "${third.json?.decision}"`);
      } else if (third.json?.result?.smoke !== true) {
        fail('replay after report', 'the recorded result was not replayed');
      } else {
        ok('report + replay', 'outcome recorded and replayed verbatim');
      }
    }
  }
}

console.log();
if (failures.length) {
  console.error('FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\nDo not promote this build to production.');
  process.exit(1);
}
console.log(`All checks passed against ${BASE}.`);
