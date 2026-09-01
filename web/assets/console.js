import { mountChrome, highlight, tabs, esc } from '/assets/partials.js';
mountChrome('/console');

/* ------------------------------------------------------------------ helpers */

const $ = (id) => document.getElementById(id);
const show = (id) => { $(id).hidden = false; };
const hide = (id) => { $(id).hidden = true; };

// A key supplied via ?key= is kept in memory only. It is never written to
// localStorage, so it cannot outlive the tab or leak to another script.
let apiKey = new URLSearchParams(location.search).get('key');

/**
 * Which plan the visitor picked on the pricing page.
 *
 * All three pricing buttons used to point at a bare /console, so someone who
 * clicked "Subscribe to Scale" — having decided to spend $249 a month — landed
 * on a generic signup form with no memory of it, and had to find the Billing
 * tab and choose again. A real user noticed and asked whether the three buttons
 * did anything different. They did not.
 */
const wantedPlan = ['pro', 'scale'].includes(
  new URLSearchParams(location.search).get('plan') ?? '')
  ? new URLSearchParams(location.search).get('plan')
  : null;

if (apiKey) history.replaceState(null, '', location.pathname);

async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.body) headers['content-type'] = 'application/json';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`/v1${path}`, {
    ...opts, headers, credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`);
    err.code = data?.error?.code;
    err.status = res.status;
    err.detail = data?.error?.detail;
    throw err;
  }
  return data;
}

const usd = (m) => {
  const v = (m ?? 0) / 1_000_000;
  return v === 0 ? '$0.00'
    : Math.abs(v) < 0.01 ? `$${v.toFixed(6).replace(/0+$/, '')}`
    : `$${v.toFixed(2)}`;
};
const num = (n) => (n ?? 0).toLocaleString();
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return d.toLocaleDateString();
};

const STATE_PILL = {
  succeeded: 'go', failed: 'stop', denied: 'stop', cancelled: 'flat',
  pending: 'wait', awaiting_approval: 'wait', indeterminate: 'unk',
};
const pill = (state) => `<span class="pill ${STATE_PILL[state] ?? 'flat'}">${esc(state)}</span>`;

const empty = (msg, hint) =>
  `<div class="empty"><p style="margin:0 0 0.3rem">${esc(msg)}</p>${
    hint ? `<p class="small" style="margin:0">${hint}</p>` : ''}</div>`;

const table = (headers, rows) => rows.length === 0 ? '' : `
  <div class="table-scroll"><table>
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;

/* ------------------------------------------------------------------- signup */

show('signup-view');
if (wantedPlan) {
  const el = $('signup-error');
  if (el) {
    el.innerHTML = `<div class="notice"><strong>Signing up for
      ${wantedPlan === 'pro' ? 'Pro' : 'Scale'}.</strong> Create the workspace first — you will
      be taken to payment straight after, and nothing is charged until you confirm.</div>`;
  }
}

$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('signup-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  $('signup-error').innerHTML = '';
  try {
    const out = await api('/workspaces', {
      method: 'POST',
      body: { name: $('ws-name').value.trim(), email: $('ws-email').value.trim() },
    });
    apiKey = out.api_key;
    $('new-key').textContent = out.api_key;
    $('try-code').innerHTML = highlight(
`curl -X POST ${location.origin}/v1/effects/begin \\
  -H "Authorization: Bearer ${out.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "effect_type": "email.send",
    "idempotency_key": "welcome:user_123",
    "payload": { "to": "sam@example.com" }
  }'

# Run it twice. The second call returns "in_flight", not a second send.`);
    hide('signup-view');
    show('key-view');
  } catch (err) {
    $('signup-error').innerHTML =
      `<div class="notice bad">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create workspace';
  }
});

$('copy-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('new-key').textContent);
    $('copy-key').textContent = 'Copied';
    setTimeout(() => { $('copy-key').textContent = 'Copy key'; }, 1600);
  } catch {
    $('copy-key').textContent = 'Select it manually';
  }
});

$('key-done').addEventListener('click', async () => {
  hide('key-view');
  await boot();
  // Honour the plan chosen on the pricing page. Land them on Billing with the
  // subscribe buttons in front of them — deliberately NOT auto-starting
  // checkout, because someone who clicked a price button has expressed intent,
  // not consent to be charged.
  if (wantedPlan) {
    const tab = $('panel-tabs')?.querySelector('[data-tab="billing"]');
    if (tab) {
      tab.click();
      setTimeout(() => {
        const btn = $('panel')?.querySelector(`[data-sub="${wantedPlan}"]`);
        if (btn) {
          btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
          btn.classList.add('primed');
        }
      }, 400);
    }
  }
});
$('sign-out').addEventListener('click', async () => {
  apiKey = null;
  await fetch('/v1/console/signout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  location.href = '/console';
});

/* ------------------------------------------------------------------ overview */

let workspace = null;

async function boot() {
  try {
    workspace = await api('/workspace');
  } catch {
    hide('console-view');
    show('signup-view');
    return;
  }
  hide('signup-view');
  hide('key-view');
  show('console-view');

  $('ws-title').textContent = workspace.name;
  $('ws-id').textContent = workspace.workspace_id;
  $('stat-plan').textContent = workspace.plan.name ?? workspace.plan.id;
  $('stat-plan-note').textContent =
    `${num(workspace.plan.included_effects)} effects/mo included`;
  $('stat-remaining').textContent = num(workspace.usage.included_remaining);
  $('stat-used').textContent = `${num(workspace.usage.effects_this_period)} used this period`;
  $('stat-credit').textContent = usd(workspace.credit_micros);
  $('stat-spend').textContent =
    `${usd(workspace.external_spend_today.workspace_micros)} external spend today`;

  await renderAlerts();
  tabs($('panel-tabs'), (name) => { void PANELS[name](); });
}

/**
 * Surfaces only the things an operator must act on. No vanity metrics.
 */
async function renderAlerts() {
  const out = [];

  /**
   * The worker is the part nobody watches until it matters.
   *
   * If it stops, leases never expire, effects sit at `pending` for ever, and
   * every retry is answered `in_flight` — with no error anywhere. This banner
   * exists because that failure is otherwise completely silent, and the console
   * is where someone would be looking when they finally noticed something odd.
   *
   * /workerz is unauthenticated so an uptime monitor can poll it too.
   */
  try {
    const res = await fetch('/workerz');
    const w = await res.json();
    if (w.status === 'never_started') {
      out.push(`<div class="notice bad"><strong>No worker has ever checked in.</strong>
        Leases will never expire, so a crashed agent's effect stays <code>pending</code>
        for ever and every retry is told <code>in_flight</code>. The worker process must be
        deployed and long-running.</div>`);
    } else if (w.status === 'stalled') {
      out.push(`<div class="notice bad"><strong>The worker has stopped completing work.</strong>
        Stalled: <code>${esc((w.stalled_loops ?? []).join(', '))}</code>. Leases may not be
        expiring. Restart the worker process; it recovers on its own once running.</div>`);
    }
  } catch { /* the banner is a courtesy — never let it break the console */ }

  const remaining = workspace.usage.included_remaining;
  if (remaining === 0 && workspace.credit_micros <= 0) {
    out.push(`<div class="notice bad"><strong>Allowance exhausted and no credit.</strong>
      New effects are being refused with <code>402</code>. Existing effects still replay.
      Add credit under Billing.</div>`);
  } else if (remaining > 0 && remaining < workspace.plan.included_effects * 0.1) {
    out.push(`<div class="notice"><strong>${num(remaining)} included effects left</strong>
      this period. Overage will draw ${usd(workspace.plan.overage_micros_per_effect)} per effect
      from your ${usd(workspace.credit_micros)} balance.</div>`);
  }

  try {
    const [ind, appr] = await Promise.all([
      api('/effects?state=indeterminate&limit=100'),
      api('/effects?state=awaiting_approval&limit=100'),
    ]);
    if (ind.data.length) {
      out.push(`<div class="notice bad">
        <strong>${ind.data.length} effect${ind.data.length === 1 ? '' : 's'} with an unknown outcome.</strong>
        Each one may or may not have happened. Verify at the vendor, then resolve it —
        see <em>Needs attention</em>.</div>`);
    }
    try {
      const groups = await api('/groups?limit=100');
      const stuck = groups.data.filter((g) => g.pendingCompensations > 0);
      const failed = groups.data.filter((g) => g.state === 'unwind_failed');
      if (stuck.length) {
        out.push(`<div class="notice bad"><strong>${stuck.length} rollback(s) incomplete.</strong>
          Steps that already happened still need undoing — see <em>Rollbacks</em>.</div>`);
      }
      if (failed.length) {
        out.push(`<div class="notice bad"><strong>${failed.length} unit(s) could not be fully
          rolled back.</strong> Something irreversible succeeded. A person has to decide what
          to do about it.</div>`);
      }
    } catch { /* best effort */ }

    if (appr.data.length) {
      out.push(`<div class="notice"><strong>${appr.data.length} effect${appr.data.length === 1 ? '' : 's'}
        waiting for approval.</strong> Agents are blocked until you decide.</div>`);
    }
  } catch { /* the alert strip is best-effort */ }

  $('alerts').innerHTML = out.join('');
}

/* ------------------------------------------------------------------- panels */

const panel = (html) => { $('panel').innerHTML = html; };
const loading = () => panel('<p class="loading" style="padding:1.25rem">Loading…</p>');
const failed = (err) =>
  panel(`<div style="padding:1.25rem"><div class="notice bad">${esc(err.message)}</div></div>`);

const PANELS = {
  async effects() {
    loading();
    try {
      const { data } = await api('/effects?limit=50');
      if (!data.length) {
        return panel(empty('No effects yet.',
          'Call <code>POST /v1/effects/begin</code> and the first record will appear here.'));
      }
      panel(table(
        ['State', 'Type', 'Idempotency key', 'Try', 'Cost', 'Agent', 'When'],
        data.map((e) => `<tr>
          <td>${pill(e.state)}</td>
          <td class="mono">${esc(e.effect_type)}</td>
          <td class="mono" title="${esc(e.idempotency_key)}">${esc(e.idempotency_key.slice(0, 34))}</td>
          <td>${e.attempt}</td>
          <td class="mono">${usd(e.actual_cost_micros || e.estimated_cost_micros)}</td>
          <td class="small faint">${esc(e.agent_id ?? '—')}</td>
          <td class="small faint">${when(e.created_at)}</td>
        </tr>`)));
    } catch (err) { failed(err); }
  },

  async attention() {
    loading();
    try {
      const [ind, appr] = await Promise.all([
        api('/effects?state=indeterminate&limit=50'),
        api('/effects?state=awaiting_approval&limit=50'),
      ]);
      const parts = [];

      parts.push(`<div style="padding:1.25rem 1.25rem 0">
        <h3>Unknown outcome</h3>
        <p class="small dim">A lease expired before an outcome was reported. Check the vendor,
        then record what you find. Nothing else can proceed on these keys until you do.</p></div>`);
      parts.push(ind.data.length
        ? table(['Type', 'Key', 'Try', 'Since', 'Resolve as'],
            ind.data.map((e) => `<tr>
              <td class="mono">${esc(e.effect_type)}</td>
              <td class="mono">${esc(e.idempotency_key.slice(0, 30))}</td>
              <td>${e.attempt}</td>
              <td class="small faint">${when(e.updated_at)}</td>
              <td style="white-space:nowrap">
                <button class="btn small secondary" data-resolve="${esc(e.effect_id)}"
                        data-outcome="succeeded">It happened</button>
                <button class="btn small secondary" data-resolve="${esc(e.effect_id)}"
                        data-outcome="failed">It didn't</button>
                <button class="btn small danger" data-resolve="${esc(e.effect_id)}"
                        data-outcome="cancelled">Abandon</button>
              </td></tr>`))
        : empty('Nothing unresolved.', 'Every effect has a known outcome.'));

      parts.push(`<div style="padding:1.25rem 1.25rem 0;border-top:1px solid var(--border)">
        <h3>Waiting for approval</h3>
        <p class="small dim">These effect types are configured to require a human decision.</p></div>`);
      parts.push(appr.data.length
        ? table(['Type', 'Key', 'Cost', 'Requested', 'Decision'],
            appr.data.map((e) => `<tr>
              <td class="mono">${esc(e.effect_type)}</td>
              <td class="mono">${esc(e.idempotency_key.slice(0, 30))}</td>
              <td class="mono">${usd(e.estimated_cost_micros)}</td>
              <td class="small faint">${when(e.created_at)}</td>
              <td style="white-space:nowrap">
                <button class="btn small" data-approve="${esc(e.effect_id)}" data-ok="1">Approve</button>
                <button class="btn small danger" data-approve="${esc(e.effect_id)}" data-ok="">Reject</button>
              </td></tr>`))
        : empty('Nothing waiting.', 'No effect type currently requires approval.'));

      panel(parts.join(''));

      for (const btn of $('panel').querySelectorAll('[data-resolve]')) {
        btn.addEventListener('click', async () => {
          const evidence = prompt(
            'How did you verify this? Stored in the audit trail.',
            'Checked the vendor dashboard');
          if (evidence === null) return;
          btn.disabled = true;
          try {
            await api(`/effects/${btn.dataset.resolve}/resolve`, {
              method: 'POST',
              body: { outcome: btn.dataset.outcome, evidence },
            });
            await renderAlerts();
            await PANELS.attention();
          } catch (err) { failed(err); }
        });
      }
      for (const btn of $('panel').querySelectorAll('[data-approve]')) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api(`/effects/${btn.dataset.approve}/approval`, {
              method: 'POST', body: { approve: Boolean(btn.dataset.ok) },
            });
            await renderAlerts();
            await PANELS.attention();
          } catch (err) { failed(err); }
        });
      }
    } catch (err) { failed(err); }
  },

  async groups() {
    loading();
    try {
      const { data } = await api('/groups?limit=50');
      const head = `<div style="padding:1.25rem 1.25rem 0">
        <p class="small dim" style="max-width:72ch">Units of work that can be rolled back as a
        whole. A group with pending compensations has steps that succeeded and still need undoing
        — until they are done, the rollback is incomplete.</p></div>`;
      panel(head + (data.length
        ? table(['Unit of work', 'State', 'Steps', 'To undo', 'Reason', 'Started'],
            data.map((g) => `<tr>
              <td class="mono">${esc(g.groupKey)}</td>
              <td>${g.state === 'unwound' || g.state === 'committed'
                    ? `<span class="pill go">${esc(g.state)}</span>`
                    : g.state === 'unwind_failed'
                      ? '<span class="pill stop">unwind failed</span>'
                      : g.state === 'unwinding'
                        ? '<span class="pill wait">unwinding</span>'
                        : `<span class="pill flat">${esc(g.state)}</span>`}</td>
              <td>${g.effects}</td>
              <td>${g.pendingCompensations
                    ? `<strong style="color:var(--stop)">${g.pendingCompensations}</strong>` : '—'}</td>
              <td class="small faint">${esc((g.unwindReason ?? '').slice(0, 40) || '—')}</td>
              <td class="small faint">${when(g.createdAt)}</td>
            </tr>`))
        : empty('No grouped work yet.',
            'Pass <code>group_key</code> and <code>compensation</code> to <code>begin</code> to make a workflow reversible.')));
    } catch (err) { failed(err); }
  },

  /**
   * Containment.
   *
   * The emergency stop lives here because it is a human control, and a human in
   * a hurry should not have to write curl. Everything on this panel is designed
   * to be usable by someone who has just been woken up: the stop is one button,
   * it says exactly what it will do, and the volume table tells you what a
   * sensible threshold would have been.
   */
  async circuits() {
    loading();
    try {
      // This endpoint returns { circuits, rates } directly — the list routes
      // wrap their results in `data`, and this one does not.
      const data = await api('/circuits');
      const open = data.circuits.filter((c) => c.state === 'open');
      const globalStop = open.find((c) => c.effect_type === '*');

      const stopBox = globalStop
        ? `<div class="notice bad" style="margin-bottom:1rem">
             <strong>Everything is stopped.</strong> Every effect type in this workspace is being
             ${esc(globalStop.action === 'deny' ? 'refused' : 'held for approval')}.
             ${globalStop.reason ? `<br><span class="small">${esc(globalStop.reason)}</span>` : ''}
             <div style="margin-top:0.75rem">
               <button class="btn" data-close="*">Resume all effect types</button>
             </div>
           </div>`
        : `<div class="notice" style="margin-bottom:1rem">
             <strong>Emergency stop.</strong> Halts every effect type in this workspace at once.
             Agents keep running; the gate simply stops authorising them, so nothing new reaches
             the outside world. It stays stopped until you resume it.
             <div style="margin-top:0.75rem">
               <button class="btn danger" id="stop-all">Stop all effects</button>
             </div>
           </div>`;

      const perType = open.filter((c) => c.effect_type !== '*');
      const openTable = perType.length
        ? table(['Effect type', 'Doing', 'Why', 'Ends', ''],
            perType.map((c) => `<tr>
              <td class="mono">${esc(c.effect_type)}</td>
              <td><span class="pill ${c.action === 'deny' ? 'stop' : c.action === 'require_approval' ? 'wait' : 'unk'}">${esc(c.action)}</span></td>
              <td class="small">${esc(c.reason ?? '—')}</td>
              <td class="small">${c.resets_at ? esc(new Date(c.resets_at).toLocaleString()) : 'until you close it'}</td>
              <td><button class="btn small" data-close="${esc(c.effect_type)}">Close</button></td>
            </tr>`))
        : `<div style="padding:0 1.25rem 0.5rem"><p class="small dim">No effect-type breakers are open.</p></div>`;

      const rates = data.rates.length
        ? table(['Effect type', 'This hour', 'Busiest hour (30d)', 'Suggested ceiling'],
            data.rates.map((r) => `<tr>
              <td class="mono">${esc(r.effect_type)}</td>
              <td>${r.this_hour}</td>
              <td>${r.peak_hour}</td>
              <td class="mono dim">${Math.max(10, r.peak_hour * 3)}/hour</td>
            </tr>`))
        : `<div style="padding:0 1.25rem"><p class="small dim">No volume recorded yet.</p></div>`;

      panel(`<div style="padding:1.25rem 1.25rem 0">
          ${stopBox}
          <p class="small dim" style="max-width:74ch">
            Surge containment stops an effect type that is suddenly running far more often than
            usual — the loop that sends five thousand emails instead of three. It is off until you
            set a threshold on a policy. Two ways to do that:
            <code>surge_per_hour</code> if you know your traffic, or
            <code>surge_multiplier</code> if you do not — the latter asks how many times normal
            is definitely wrong, and works out "normal" from your own history. The suggested
            ceiling below is three times your busiest hour in the last thirty days.
          </p>
        </div>
        ${openTable}
        <div style="padding:1rem 1.25rem 0"><h3 class="small" style="margin:0 0 0.35rem">Volume by effect type</h3></div>
        ${rates}`);

      const stop = $('stop-all');
      if (stop) {
        stop.addEventListener('click', async () => {
          if (!confirm('Stop every effect type in this workspace?\n\n'
            + 'Agents will be refused until you resume. Nothing already performed is undone.')) return;
          const reason = prompt('Why? This is recorded and shown to callers that are stopped.',
            'stopped from the console');
          if (reason === null) return;
          try {
            await api('/circuits/*/open', { method: 'POST',
              body: { action: 'deny', reason: reason || 'stopped from the console' } });
            await PANELS.circuits();
          } catch (err) { failed(err); }
        });
      }

      for (const btn of $('panel').querySelectorAll('[data-close]')) {
        btn.addEventListener('click', async () => {
          try {
            await api(`/circuits/${encodeURIComponent(btn.dataset.close)}/close`,
              { method: 'POST', body: {} });
            await PANELS.circuits();
          } catch (err) { failed(err); }
        });
      }
    } catch (err) { failed(err); }
  },

  async policies() {
    loading();
    try {
      const { data } = await api('/policies');
      const head = `<div style="padding:1.25rem 1.25rem 0">
        <p class="small dim" style="max-width:70ch">Effect types without an explicit policy use the
        safe defaults: allowed, 60-second lease, 3 attempts, and <code>block</code> on an unknown
        outcome. Edit with <code>PUT /v1/policies/{effect_type}</code>.</p></div>`;
      panel(head + (data.length
        ? table(['Effect type', 'Mode', 'On unknown outcome', 'Lease', 'Tries', 'Max cost', 'Daily budget', 'Retention'],
            data.map((p) => `<tr>
              <td class="mono">${esc(p.effect_type)}</td>
              <td><span class="pill ${p.mode === 'deny' ? 'stop' : p.mode === 'require_approval' ? 'wait' : 'go'}">${esc(p.mode)}</span></td>
              <td><span class="pill ${p.on_indeterminate === 'retry' ? 'go' : p.on_indeterminate === 'probe' ? 'wait' : 'unk'}">${esc(p.on_indeterminate)}</span></td>
              <td>${p.lease_seconds}s</td>
              <td>${p.max_attempts}</td>
              <td class="mono">${p.max_cost_micros == null ? '—' : usd(p.max_cost_micros)}</td>
              <td class="mono">${p.daily_budget_micros == null ? '—' : usd(p.daily_budget_micros)}</td>
              <td class="mono">${p.surge_effective_ceiling == null ? '—'
                : `${p.surge_effective_ceiling}<span class="faint small">${
                    p.surge_ceiling_source === 'learned'
                      ? ` (${p.surge_multiplier}× ${p.surge_baseline_per_hour}/hr)` : ''}</span>`}</td>
              <td>${p.retention_days}d</td>
            </tr>`))
        : empty('No explicit policies.', 'Every effect type is using the safe defaults.')));
    } catch (err) { failed(err); }
  },

  async keys() {
    loading();
    try {
      const { data } = await api('/keys');
      panel(`<div style="padding:1.25rem">
        <div id="key-result"></div>
        <form id="new-key-form" style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:190px">
            <label for="key-name">New key name</label>
            <input id="key-name" required maxlength="100" placeholder="production-worker">
          </div>
          <div style="flex:1;min-width:190px">
            <label for="key-scopes">Scopes</label>
            <select id="key-scopes">
              <option value="effects:begin,effects:report">Gate only (least privilege)</option>
              <option value="effects:begin,effects:report,effects:read">Gate and read</option>
              <option value="effects:begin,effects:report,effects:read,effects:admin,policies:read,policies:write,workspace:read">Full access</option>
              <option value="effects:read,workspace:read">Read only</option>
            </select>
          </div>
          <button class="btn" type="submit">Create key</button>
        </form>
      </div>` + table(['Name', 'Prefix', 'Scopes', 'Last used', 'Status', ''],
        data.map((k) => `<tr>
          <td>${esc(k.name)}</td>
          <td class="mono">${esc(k.prefix)}</td>
          <td class="small faint">${k.scopes.map(esc).join(', ')}</td>
          <td class="small faint">${when(k.lastUsedAt)}</td>
          <td>${k.revoked ? '<span class="pill stop">revoked</span>' : '<span class="pill go">active</span>'}</td>
          <td>${k.revoked ? '' : `<button class="btn small danger" data-revoke="${esc(k.id)}">Revoke</button>`}</td>
        </tr>`)));

      $('new-key-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const made = await api('/keys', {
            method: 'POST',
            body: { name: $('key-name').value.trim(), scopes: $('key-scopes').value.split(',') },
          });
          $('key-result').innerHTML =
            `<div class="notice good">Copy this now — it will not be shown again.</div>
             <div class="secret">${esc(made.api_key)}</div>`;
          const rows = await api('/keys');
          void rows;
        } catch (err) {
          $('key-result').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
        }
      });

      for (const btn of $('panel').querySelectorAll('[data-revoke]')) {
        btn.addEventListener('click', async () => {
          if (!confirm('Revoke this key? Any agent using it stops working immediately.')) return;
          try {
            await api(`/keys/${btn.dataset.revoke}`, { method: 'DELETE' });
            await PANELS.keys();
          } catch (err) { failed(err); }
        });
      }
    } catch (err) { failed(err); }
  },

  async webhooks() {
    loading();
    try {
      const [eps, dels] = await Promise.all([api('/webhooks'), api('/webhooks/deliveries')]);
      panel(`<div style="padding:1.25rem">
        <div id="wh-result"></div>
        <form id="wh-form" style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:2;min-width:230px">
            <label for="wh-url">Endpoint URL</label>
            <input id="wh-url" required type="url" placeholder="https://hooks.example.com/ratchet">
            <p class="hint">https only. Private and loopback addresses are refused, at
              registration and again at delivery.</p>
          </div>
          <div style="flex:1;min-width:190px">
            <label for="wh-events">Events</label>
            <select id="wh-events">
              <option value="effect.indeterminate">Unknown outcomes only</option>
              <option value="effect.indeterminate,effect.approval_required">Unknown + approvals</option>
              <option value="effect.succeeded,effect.failed,effect.indeterminate,effect.approval_required">All effect events</option>
            </select>
          </div>
          <button class="btn" type="submit">Add endpoint</button>
        </form>
      </div>`
      + (eps.data.length ? table(['URL', 'Events', 'Status', ''], eps.data.map((e) => `<tr>
            <td class="mono small">${esc(e.url)}</td>
            <td class="small faint">${e.events.map(esc).join(', ')}</td>
            <td>${e.disabled ? '<span class="pill flat">disabled</span>' : '<span class="pill go">active</span>'}</td>
            <td>${e.disabled ? '' : `<button class="btn small danger" data-wh="${esc(e.id)}">Disable</button>`}</td>
          </tr>`)) : empty('No endpoints.', 'Add one to be told the moment an outcome becomes unknown.'))
      + (dels.data.length ? `<div style="padding:1.25rem 1.25rem 0;border-top:1px solid var(--border)">
            <h3>Recent deliveries</h3></div>`
          + table(['Event', 'State', 'Tries', 'Status', 'Error', 'When'], dels.data.map((d) => `<tr>
              <td class="mono small">${esc(d.eventType)}</td>
              <td>${d.state === 'delivered' ? '<span class="pill go">delivered</span>'
                    : d.state === 'dead' ? '<span class="pill stop">dead</span>'
                    : '<span class="pill wait">' + esc(d.state) + '</span>'}</td>
              <td>${d.attempts}</td>
              <td class="small faint">${d.lastStatus ?? '—'}</td>
              <td class="small faint">${esc((d.lastError ?? '').slice(0, 44))}</td>
              <td class="small faint">${when(d.createdAt)}</td>
            </tr>`)) : ''));

      $('wh-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const made = await api('/webhooks', {
            method: 'POST',
            body: { url: $('wh-url').value.trim(), events: $('wh-events').value.split(',') },
          });
          $('wh-result').innerHTML =
            `<div class="notice good">Endpoint added. Save the signing secret — shown once.</div>
             <div class="secret">${esc(made.signing_secret)}</div>`;
        } catch (err) {
          $('wh-result').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
        }
      });
      for (const btn of $('panel').querySelectorAll('[data-wh]')) {
        btn.addEventListener('click', async () => {
          try { await api(`/webhooks/${btn.dataset.wh}`, { method: 'DELETE' }); await PANELS.webhooks(); }
          catch (err) { failed(err); }
        });
      }
    } catch (err) { failed(err); }
  },

  async billing() {
    loading();
    try {
      const [plans, ledger] = await Promise.all([api('/billing/plans'), api('/usage/ledger')]);
      const pr = plans.provider;
      panel(`<div style="padding:1.25rem">
        ${pr.live ? '' : `<div class="notice"><strong>Test mode.</strong> ${esc(pr.note)}
          The full credit ledger, entitlement, and idempotency path runs — no card is charged.</div>`}
        <div id="pay-result"></div>
        <div id="sub-block"></div>
        <h3>Add prepaid credit</h3>
        <p class="small dim">Overage draws from this balance. At zero, new effects are refused;
          replays of existing effects keep working.</p>
        <div class="actions" style="margin-top:0.75rem">
          ${plans.credit_packs.map((p) =>
            `<button class="btn secondary" data-pack="${esc(p.id)}">${esc(p.label)}</button>`).join('')}
        </div>
      </div>`
      + (ledger.data.length ? `<div style="padding:0 1.25rem"><h3>Ledger</h3></div>`
          + table(['Kind', 'Amount', 'Balance after', 'Effect', 'When'], ledger.data.map((l) => `<tr>
              <td class="mono small">${esc(l.kind)}</td>
              <td class="mono" style="color:${l.deltaMicros < 0 ? 'var(--stop)' : 'var(--ok)'}">
                ${l.deltaMicros < 0 ? '' : '+'}${usd(l.deltaMicros)}</td>
              <td class="mono">${usd(l.balanceAfter)}</td>
              <td class="mono small faint">${esc(l.effectId ?? '—')}</td>
              <td class="small faint">${when(l.createdAt)}</td>
            </tr>`))
          : empty('No credit movements yet.', 'Included usage costs nothing and writes no ledger row.')));

      // Subscription state + upgrade path.
      const paid = plans.plans.filter((p) => p.monthly_price_micros > 0);
      const onPaid = workspace.plan.id !== 'free';
      $('sub-block').innerHTML = `
        <h3>Plan</h3>
        <p class="small dim">Currently on <strong>${esc(workspace.plan.name ?? workspace.plan.id)}</strong>
          — ${num(workspace.plan.included_effects)} gated effects a month.</p>
        ${onPaid
          ? '<p class="small faint">Manage or cancel from the receipt emailed by the payment provider.</p>'
          : `<div class="actions" style="margin:0.75rem 0 1.5rem">
               ${paid.map((p) => `<button class="btn" data-sub="${esc(p.id)}">
                 Subscribe to ${esc(p.name)} — $${(p.monthly_price_micros / 1e6).toFixed(0)}/mo
               </button>`).join('')}
             </div>`}`;

      for (const btn of $('panel').querySelectorAll('[data-sub]')) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const co = await api('/billing/subscribe', {
              method: 'POST', body: { plan_id: btn.dataset.sub },
            });
            if (co.url) { location.href = co.url; return; }
            $('pay-result').innerHTML =
              '<div class="notice bad">No checkout URL was returned.</div>';
          } catch (err) {
            $('pay-result').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
          } finally { btn.disabled = false; }
        });
      }

      // Crypto top-ups, when the instance is configured for them.
      try {
        const c = await (await fetch('/v1/billing/crypto/assets')).json();
        if (c.enabled && c.assets.length) {
          const box = document.createElement('div');
          box.style.cssText = 'padding:0 1.25rem 1.25rem';
          box.innerHTML = `<h3>Or pay with crypto</h3>
            <p class="small dim">Non-custodial: funds go directly to an address the operator
              controls. Quoted in USD, so a price move cannot change your credit.</p>
            <div class="actions">${c.assets.map((a) =>
              `<button class="btn secondary" data-crypto="${esc(a.token_mint)}">
                 $25 in ${esc(a.symbol)}</button>`).join('')}</div>
            <div id="crypto-result"></div>`;
          $('panel').appendChild(box);
          for (const b of box.querySelectorAll('[data-crypto]')) {
            b.addEventListener('click', async () => {
              b.disabled = true;
              try {
                const i = await api('/billing/crypto/intents', {
                  method: 'POST', body: { token_mint: b.dataset.crypto, usd_micros: 25_000_000 },
                });
                document.getElementById('crypto-result').innerHTML = `
                  <div class="notice">Send exactly <strong>${esc(i.amount)} ${esc(i.symbol)}</strong>
                    with memo <code>${esc(i.memo)}</code>. Quote expires ${when(i.expires_at)}.</div>
                  <div class="secret">${esc(i.destination)}</div>
                  <p class="small faint">${i.instructions.map(esc).join('<br>')}</p>`;
              } catch (err) {
                document.getElementById('crypto-result').innerHTML =
                  `<div class="notice bad">${esc(err.message)}</div>`;
              } finally { b.disabled = false; }
            });
          }
        }
      } catch { /* crypto is optional; its absence is not an error */ }

      for (const btn of $('panel').querySelectorAll('[data-pack]')) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const co = await api('/billing/checkout', {
              method: 'POST', body: { pack_id: btn.dataset.pack },
            });
            if (co.url) { location.href = co.url; return; }
            // Test mode: settle locally, exactly as a provider webhook would.
            const done = await api('/billing/test/settle', {
              method: 'POST', body: { session_id: co.session_id, pack_id: btn.dataset.pack },
            });
            $('pay-result').innerHTML = `<div class="notice good">
              Test credit applied. Balance: ${usd(done.credit_micros)}. No money moved.</div>`;
            workspace = await api('/workspace');
            $('stat-credit').textContent = usd(workspace.credit_micros);
            await renderAlerts();
            await PANELS.billing();
          } catch (err) {
            $('pay-result').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
          } finally { btn.disabled = false; }
        });
      }
    } catch (err) { failed(err); }
  },

  async alerts() {
    loading();
    try {
      const [prefs, msgs] = await Promise.all([
        api('/email/preferences'), api('/email/messages'),
      ]);
      panel(`<div style="padding:1.25rem">
        ${prefs.suppressed
          ? `<div class="notice bad"><strong>Delivery to ${esc(prefs.to)} is suppressed.</strong>
             ${esc(prefs.suppress_reason ?? 'The address bounced permanently.')}
             Nothing further is sent until it is corrected — continuing to send to a bad
             address is how a sending domain gets blocked.</div>`
          : ''}
        ${prefs.delivery_configured
          ? ''
          : `<div class="notice"><strong>No mail provider is configured.</strong> Alerts are
             queued and logged but not delivered. Set <code>EMAIL_PROVIDER</code> and
             <code>EMAIL_API_KEY</code> to turn delivery on.</div>`}
        <h3>Where alerts go</h3>
        <p class="small dim">${esc(prefs.to ?? 'no address on file')}</p>
        <h3 style="margin-top:1.25rem">What you receive</h3>
        <p class="small dim">Alerts are digested, not sent per event: however many effects go
          unknown in an hour, you get one email about all of them.</p>
      </div>`
      + table(['Alert', 'What it covers', 'On'], prefs.preferences.map((p) => `<tr>
          <td class="mono">${esc(p.category)}${p.operational ? '' : ''}</td>
          <td class="small faint">${esc(p.description)}</td>
          <td><button class="btn small ${p.enabled ? '' : 'secondary'}"
                data-pref="${esc(p.category)}" data-on="${p.enabled ? '1' : ''}">
                ${p.enabled ? 'On' : 'Off'}</button></td>
        </tr>`))
      + (msgs.data.length
          ? `<div style="padding:1.25rem 1.25rem 0;border-top:1px solid var(--border)">
               <h3>Recently sent</h3></div>`
            + table(['Category', 'Subject', 'State', 'When'], msgs.data.map((m) => `<tr>
                <td class="mono small">${esc(m.category)}</td>
                <td class="small">${esc(m.subject)}</td>
                <td>${m.state === 'sent' ? '<span class="pill go">sent</span>'
                      : m.state === 'dead' ? '<span class="pill stop">failed</span>'
                      : m.state === 'suppressed' ? '<span class="pill stop">suppressed</span>'
                      : `<span class="pill wait">${esc(m.state)}</span>`}</td>
                <td class="small faint">${when(m.sentAt ?? m.createdAt)}</td>
              </tr>`))
          : empty('No alerts sent yet.', 'You will hear from Ratchet when something needs you.')));

      for (const btn of $('panel').querySelectorAll('[data-pref]')) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api(`/email/preferences/${btn.dataset.pref}`, {
              method: 'PUT', body: { enabled: !btn.dataset.on },
            });
            await PANELS.alerts();
          } catch (err) { failed(err); }
        });
      }
    } catch (err) { failed(err); }
  },

  async audit() {
    loading();
    try {
      const { data } = await api('/audit');
      panel(data.length
        ? table(['Action', 'Actor', 'Subject', 'When'], data.map((a) => `<tr>
            <td class="mono small">${esc(a.action)}</td>
            <td class="small faint">${esc(a.actor)}</td>
            <td class="mono small faint">${esc(a.subjectId ?? '—')}</td>
            <td class="small faint">${when(a.createdAt)}</td>
          </tr>`))
        : empty('No audit events yet.'));
    } catch (err) { failed(err); }
  },

  async integrate() {
    const origin = location.origin;
    panel(`<div style="padding:1.25rem">
      <h3>Endpoints</h3>
      <dl class="kv" style="margin-bottom:1.5rem">
        <dt>REST base</dt><dd class="mono">${origin}/v1</dd>
        <dt>MCP (HTTP)</dt><dd class="mono">${origin}/mcp</dd>
        <dt>OpenAPI</dt><dd><a href="/openapi.json">/openapi.json</a></dd>
        <dt>Manifest</dt><dd><a href="/.well-known/agent-manifest.json">/.well-known/agent-manifest.json</a></dd>
        <dt>llms.txt</dt><dd><a href="/llms.txt">/llms.txt</a></dd>
        <dt>MCP tools</dt><dd><a href="/mcp/info">/mcp/info</a></dd>
      </dl>
      <h3>The loop</h3>
      <pre><code>${highlight(
`# Ask
POST ${origin}/v1/effects/begin
{ "effect_type": "email.send", "idempotency_key": "welcome:user_123" }

# If decision == "execute", act, then:
POST ${origin}/v1/effects/{effect_id}/report
{ "lease_token": "...", "outcome": "succeeded", "result": { ... } }`)}</code></pre>
      <p class="small faint">Full walkthrough in the <a href="/docs">docs</a>.</p>
    </div>`);
  },
};

void boot();
