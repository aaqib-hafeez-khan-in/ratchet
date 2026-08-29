import { mountChrome, esc } from '/assets/partials.js';
mountChrome('/pricing');

const usd = (micros) => {
  const v = micros / 1_000_000;
  return v === 0 ? '$0'
    : v >= 1 ? `$${v.toFixed(0)}`
    : `$${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
};
const per1k = (micros) => `$${((micros * 1000) / 1_000_000).toFixed(2)} per 1,000`;

try {
  const res = await fetch('/v1/billing/plans');
  const data = await res.json();

  document.getElementById('plans').innerHTML = data.plans.map((p) => `
    <div class="card">
      <h3>${esc(p.name)}</h3>
      <p style="font-size:1.9rem;font-weight:640;letter-spacing:-0.03em;margin:0.2rem 0 0.1rem">
        ${usd(p.monthly_price_micros)}<span class="faint" style="font-size:0.95rem;font-weight:400">${p.monthly_price_micros ? '/mo' : ''}</span>
      </p>
      <p class="small faint" style="margin-bottom:1rem">
        ${p.included_effects.toLocaleString()} gated effects included
      </p>
      <dl class="kv">
        <dt>Overage</dt><dd>${per1k(p.overage_micros_per_effect)}</dd>
        <dt>Rate limit</dt><dd>${p.rate_limit_per_minute.toLocaleString()}/min</dd>
        <dt>Retention</dt><dd>${p.max_retention_days} days</dd>
        <dt>API keys</dt><dd>${p.max_api_keys}</dd>
        <dt>Webhooks</dt><dd>${p.max_webhook_endpoints}</dd>
      </dl>
      <div class="actions">
        <a class="btn ${p.id === 'free' ? '' : 'secondary'}" href="/console">
          ${p.id === 'free' ? 'Start free' : 'Choose ' + esc(p.name)}</a>
      </div>
    </div>`).join('');

  const pr = data.provider;
  document.getElementById('provider').innerHTML = pr.live
    ? `<p style="margin:0"><span class="pill go">live</span> Payments are processed by
       ${esc(pr.name)}. Card details are entered on the provider's own page and never reach Ratchet.</p>`
    : `<p style="margin:0 0 0.6rem"><span class="pill wait">test mode</span>
       <strong>No live payment provider is configured on this instance.</strong></p>
       <p class="small dim" style="margin:0">
       Credit purchases run through the built-in test adapter: the full credit ledger, entitlement,
       and idempotency path executes, but no card is charged and no external request is made.
       Every response says <code>test_mode: true</code>. Set <code>BILLING_PROVIDER</code>,
       <code>STRIPE_SECRET_KEY</code>, and <code>STRIPE_WEBHOOK_SECRET</code> to take live payments.</p>`;
} catch {
  document.getElementById('plans').innerHTML =
    '<p class="notice bad">Could not load pricing. The API may be unavailable.</p>';
  document.getElementById('provider').innerHTML =
    '<p class="small dim" style="margin:0">Billing status unavailable.</p>';
}
