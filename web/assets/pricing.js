// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { mountChrome, esc } from '/assets/partials.js';
mountChrome('/pricing');

const usd = (micros) => {
  const v = micros / 1_000_000;
  return v === 0 ? '$0'
    : v >= 1 ? `$${v.toFixed(0)}`
    : `$${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
};
const per1k = (micros) => `$${((micros * 1000) / 1_000_000).toFixed(2)} per 1,000`;

/**
 * The capability rows, rendered from what the API publishes rather than typed
 * here. The server reads them off the same PLANS object the guards enforce, so
 * this table cannot promise something the code refuses — which is the one kind
 * of marketing copy that is also a broken promise.
 *
 * Every tier shows every row, present or not. A reader comparing plans wants to
 * see what they are not getting; a card that lists only its own features makes
 * them open three tabs.
 */
const CAPABILITIES = [
  ['reversible_groups', 'Reversible effect groups', 'Undo a half-finished unit of work'],
  ['signed_receipts', 'Signed receipts', 'Verify each decision without trusting us'],
  ['reconciliation', 'Reconciliation', 'Find actions that bypassed the gate'],
];

const capabilityList = (p) => `
  <ul class="caps">
    ${CAPABILITIES.map(([key, label, why]) => {
      const on = Boolean(p.capabilities?.[key]);
      return `<li class="${on ? 'on' : 'off'}">
        <span class="capmark" aria-hidden="true">${on ? '&#10003;' : '&#8211;'}</span>
        <span><strong>${esc(label)}</strong><span class="capwhy">${esc(why)}</span></span>
        <span class="visually-hidden">${on ? 'included' : 'not included'}</span>
      </li>`;
    }).join('')}
  </ul>`;

try {
  const res = await fetch('/v1/billing/plans');
  const data = await res.json();

  document.getElementById('plans').innerHTML = data.plans.map((p) => `
    <div class="card">
      <h3>${esc(p.name)}</h3>
      <p style="font-size:1.9rem;font-weight:640;letter-spacing:-0.03em;margin:0.2rem 0 0.1rem">
        ${p.self_serve
          ? `${usd(p.monthly_price_micros)}<span class="faint" style="font-size:0.95rem;font-weight:400">${p.monthly_price_micros ? '/mo' : ''}</span>`
          : 'Custom'}
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
      ${capabilityList(p)}
      <div class="actions">
        ${p.self_serve
          ? `<a class="btn ${p.id === 'free' ? 'secondary' : ''}"
               href="/console${p.id === 'free' ? '' : `?plan=${encodeURIComponent(p.id)}`}">
              ${p.id === 'free' ? 'Start free' : 'Subscribe to ' + esc(p.name)}</a>`
          : '<a class="btn secondary" href="mailto:hello@ratchetgate.com'
            + '?subject=Ratchet%20Enterprise">Talk to us</a>'}
      </div>
      ${p.id === 'free' ? '' : p.self_serve
        ? '<p class="small faint" style="margin:0.6rem 0 0">Billed monthly, cancel anytime. '
          + 'Overage draws from prepaid credit, so it can never exceed what you loaded.</p>'
        : '<p class="small faint" style="margin:0.6rem 0 0">Priced against what you are '
          + 'protecting rather than a list rate, so it is arranged directly. Every control '
          + 'above ships on every plan &mdash; this tier is limits and terms, never safety.</p>'}
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
  const cs = document.getElementById('crypto-status');
  if (cs) {
    cs.innerHTML = data.crypto?.enabled
      // A bare API path dropped mid-sentence reads like a broken template.
      // Name the destination in prose and tag the format, the way the footer
      // does, so a person knows they are about to get JSON.
      ? '<span class="pill go">enabled</span> '
        + '<a href="/v1/billing/crypto/assets" target="_blank" rel="noopener">'
        + 'See the accepted assets<span class="fmt">JSON</span></a>'
      : '<span class="pill flat">not configured</span> This instance has no receiving address set, '
        + 'so crypto payments are off.';
  }
} catch {
  document.getElementById('plans').innerHTML =
    '<p class="notice bad">Could not load pricing. The API may be unavailable.</p>';
  document.getElementById('provider').innerHTML =
    '<p class="small dim" style="margin:0">Billing status unavailable.</p>';
}

import { revealSections } from '/assets/reveal.js';
revealSections({});
