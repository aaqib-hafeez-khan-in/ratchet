import { mountChrome } from '/assets/partials.js';

/**
 * The status page checks from the reader's browser, not from us.
 *
 * A status page that reports what its own server says about itself is worth
 * very little — the interesting failures are the ones where the server is
 * confident and wrong. Running the checks client-side at least means the
 * reader's own network reached production, which is the question they came
 * with.
 *
 * Set this to the external status page once one exists. Left empty, the page
 * says plainly that there is no third-party monitor to link rather than
 * pretending the checks above are independent.
 */
const EXTERNAL_STATUS_URL = '';

const CHECKS = [
  { id: 'control-plane', label: 'Control plane', path: '/healthz',
    ok: (r) => r.status === 200,
    detail: () => 'Serving requests' },
  { id: 'readiness', label: 'Readiness', path: '/readyz',
    ok: (r) => r.status === 200,
    detail: () => 'Database reachable' },
  { id: 'lease-expiry', label: 'Lease expiry', path: '/workerz',
    ok: (r) => r.status === 200 && r.json?.status === 'ok',
    // The worker reports how many loops are running and, since 1 Sep, whether
    // the database replicas are keeping up. Both are worth showing: a reader
    // deciding whether to trust this with a payment wants more than a tick.
    detail: (r) => {
      const bits = [];
      if (typeof r.json?.loops === 'number') bits.push(`${r.json.loops} loops running`);
      if (r.json?.replication === 'ok') bits.push('replicas in sync');
      else if (r.json?.replication === 'degraded') bits.push('replica lag');
      if (r.json?.status && r.json.status !== 'ok') bits.push(r.json.status);
      return bits.join(' · ') || 'Running';
    } },
];

async function probe(path) {
  const started = performance.now();
  try {
    const res = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
    let json = null;
    try { json = await res.json(); } catch { /* not every endpoint returns JSON */ }
    return { status: res.status, json, ms: Math.round(performance.now() - started) };
  } catch (err) {
    // A network error is a real answer, not an absence of one.
    return { status: 0, json: null, ms: Math.round(performance.now() - started),
             error: err instanceof Error ? err.message : String(err) };
  }
}

function render(results) {
  const el = document.getElementById('checks');
  el.innerHTML = results.map(({ check, result, healthy }) => `
    <div class="statusrow ${healthy ? 'is-ok' : 'is-down'}">
      <span class="statusdot" aria-hidden="true"></span>
      <span class="statuslabel">${check.label}</span>
      <span class="statusdetail">${healthy ? check.detail(result)
        : result.status === 0 ? 'Unreachable from your browser' : `HTTP ${result.status}`}</span>
      <span class="statusms">${result.ms} ms</span>
    </div>`).join('');

  const down = results.filter((r) => !r.healthy).length;
  const summary = document.getElementById('checked-at');
  const when = new Date().toLocaleTimeString();
  summary.textContent = down === 0
    ? `All checks passed at ${when}, from your browser.`
    : `${down} of ${results.length} checks failing as of ${when}.`;
}

async function run() {
  const results = await Promise.all(CHECKS.map(async (check) => {
    const result = await probe(check.path);
    return { check, result, healthy: check.ok(result) };
  }));
  render(results);
}

const external = document.getElementById('external-status');
if (external) {
  external.innerHTML = EXTERNAL_STATUS_URL
    ? `The external monitor is at <a href="${EXTERNAL_STATUS_URL}" target="_blank"
         rel="noopener">${new URL(EXTERNAL_STATUS_URL).host}</a>, which stays up when we do not.`
    : `<span class="faint">An external status page is being set up. Until it is linked here,
        the checks above are the only ones you can see — and they cannot tell you the site
        is down, only that it is up.</span>`;
}

mountChrome('/status');
run();
// Re-check while the page is open, but only while it is actually being looked at.
setInterval(() => { if (!document.hidden) run(); }, 30_000);
