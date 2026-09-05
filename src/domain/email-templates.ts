// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { config } from '../lib/config.js';

/**
 * Email bodies.
 *
 * Written to be read on a phone at an awkward hour, because that is when the
 * important ones arrive. Each says what happened, what it means, and the one
 * thing to do — in that order.
 *
 * Deliberately absent: payloads, results, API keys, and effect contents. An
 * email is an unencrypted copy that lives forever in someone's inbox and gets
 * forwarded. Detail stays behind the console link.
 */

const base = () => config.publicUrl.replace(/\/$/, '');

/**
 * Escape a value before it goes into email HTML.
 *
 * Everything interpolated here is caller-controlled — an API key name, an
 * effect type — and an email is rendered as HTML by the recipient's client.
 * Unescaped, a crafted key name injects markup into a message that appears to
 * come from Ratchet, which is a phishing primitive even where the client strips
 * scripts. The plain-text part needs no escaping; this is only for the HTML.
 */
const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function wrap(title: string, body: string, action: { label: string; href: string }): string {
  // Table layout and inline styles, because mail clients discard most CSS.
  // Plain text is the primary format; this is the courtesy version.
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e6ea;border-radius:10px">
<tr><td style="padding:24px 26px 8px">
  <div style="font:600 15px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#14171c">Ratchet</div>
</td></tr>
<tr><td style="padding:0 26px 4px">
  <h1 style="margin:12px 0 10px;font:640 21px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#14171c">${esc(title)}</h1>
</td></tr>
<tr><td style="padding:0 26px 18px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#3d4450">
  ${body}
</td></tr>
<tr><td style="padding:0 26px 28px">
  <a href="${action.href}" style="display:inline-block;background:#1c5cff;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font:550 14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${action.label}</a>
</td></tr>
<tr><td style="padding:16px 26px 22px;border-top:1px solid #e3e6ea;font:12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#868d99">
  You are receiving this because it affects work your agents are doing.
  <a href="${base()}/console" style="color:#5b626d">Manage which alerts you get</a>.
</td></tr>
</table></td></tr></table></body></html>`;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function indeterminateAlert(n: number, types: string[]) {
  const list = types.slice(0, 5).join(', ') + (types.length > 5 ? `, and ${types.length - 5} more` : '');
  const subject = n === 1
    ? 'An effect finished in an unknown state'
    : `${n} effects finished in an unknown state`;
  const text =
`${plural(n, 'effect')} in your workspace ${n === 1 ? 'has' : 'have'} an unknown outcome.

An agent took a lease, then never reported back — it crashed, timed out, or lost
its connection partway. Ratchet does not guess in that situation, so ${n === 1 ? 'this effect is' : 'these effects are'}
recorded as indeterminate rather than quietly retried.

Affected effect ${types.length === 1 ? 'type' : 'types'}: ${list}

What this means: the real-world action may or may not have happened. Until
someone checks, no agent can safely repeat it — and Ratchet will keep refusing
to let them.

What to do: check the vendor, then record what you find. Everything unblocks
from there.

  ${base()}/console

You are receiving this because it affects work your agents are doing.
Manage alerts: ${base()}/console`;

  const html = wrap(subject,
    `<p style="margin:0 0 12px"><strong>${plural(n, 'effect')}</strong> in your workspace ${n === 1 ? 'has' : 'have'} an unknown outcome.</p>
     <p style="margin:0 0 12px">An agent took a lease, then never reported back — it crashed, timed out, or lost its connection partway. Ratchet does not guess, so ${n === 1 ? 'it is' : 'they are'} recorded as <strong>indeterminate</strong> rather than quietly retried.</p>
     <p style="margin:0 0 12px;color:#5b626d">Affected: <code style="background:#f6f7f9;padding:2px 6px;border-radius:4px">${esc(list)}</code></p>
     <p style="margin:0 0 12px">The real-world action may or may not have happened. Until someone checks, no agent can safely repeat it — and Ratchet will keep refusing to let them.</p>
     <p style="margin:0"><strong>Check the vendor, then record what you find.</strong> Everything unblocks from there.</p>`,
    { label: 'Resolve these effects', href: `${base()}/console` });

  return { subject, text, html };
}

export function rollbackAlert(stuck: number, failed: number) {
  const subject = failed > 0
    ? `A rollback could not finish`
    : `${plural(stuck, 'rollback')} still ${stuck === 1 ? 'has' : 'have'} steps to undo`;
  const text =
`${failed > 0
  ? `${plural(failed, 'unit')} of work could not be fully rolled back. Something that
succeeded declared no way to undo itself — an email that was sent, a message
that was posted. A person has to decide what to do about it.`
  : `${plural(stuck, 'rollback')} in your workspace ${stuck === 1 ? 'is' : 'are'} incomplete. Steps that already
happened still need undoing, and until they are done the rollback has not
actually rolled anything back.`}

  ${base()}/console

Manage alerts: ${base()}/console`;

  const html = wrap(subject,
    failed > 0
      ? `<p style="margin:0 0 12px"><strong>${plural(failed, 'unit')}</strong> of work could not be fully rolled back.</p>
         <p style="margin:0 0 12px">Something that succeeded declared no way to undo itself — an email that was sent, a message that was posted. Ratchet will not call that a clean rollback.</p>
         <p style="margin:0"><strong>A person has to decide what to do about it.</strong></p>`
      : `<p style="margin:0 0 12px"><strong>${plural(stuck, 'rollback')}</strong> ${stuck === 1 ? 'is' : 'are'} incomplete.</p>
         <p style="margin:0">Steps that already happened still need undoing. Until they are, the rollback has not actually rolled anything back.</p>`,
    { label: 'Open rollbacks', href: `${base()}/console` });

  return { subject, text, html };
}

export function approvalAlert(n: number) {
  const subject = n === 1 ? 'An agent is waiting for your approval' : `${n} effects are waiting for approval`;
  const text =
`${plural(n, 'effect')} ${n === 1 ? 'is' : 'are'} waiting on a decision from you. The agents that
requested ${n === 1 ? 'it' : 'them'} are blocked until you approve or reject.

  ${base()}/console

Manage alerts: ${base()}/console`;
  const html = wrap(subject,
    `<p style="margin:0 0 12px"><strong>${plural(n, 'effect')}</strong> ${n === 1 ? 'is' : 'are'} waiting on a decision from you.</p>
     <p style="margin:0">The agents that requested ${n === 1 ? 'it' : 'them'} are blocked until you approve or reject.</p>`,
    { label: 'Review and decide', href: `${base()}/console` });
  return { subject, text, html };
}

export function circuitAlert(
  open: Array<{ effectType: string; action: string; reason: string | null;
                resetsAt: Date | null }>,
) {
  const n = open.length;
  const global = open.some((c) => c.effectType === '*');
  const subject = global
    ? 'Everything is stopped: a workspace-wide circuit breaker is open'
    : n === 1
      ? `Circuit breaker open: ${open[0]!.effectType}`
      : `${n} circuit breakers are open`;

  // What the operator needs at 3am, in order: what stopped, why, what happens
  // if they do nothing, and where to look.
  const line = (c: typeof open[number]) => {
    const what = c.effectType === '*' ? 'Every effect type' : c.effectType;
    const doing = c.action === 'deny' ? 'being refused'
      : c.action === 'require_approval' ? 'waiting for your approval'
      : 'still running (monitor only)';
    const until = c.resetsAt
      ? `clears on its own at ${c.resetsAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`
      : 'stays open until you close it';
    return { what, doing, until, why: c.reason ?? 'threshold exceeded' };
  };
  const rows = open.map(line);

  const text =
`${global ? 'A workspace-wide stop is in place.' : `${plural(n, 'circuit breaker')} opened.`}

${rows.map((r) => `  ${r.what}
    why:  ${r.why}
    now:  ${r.doing}
    ends: ${r.until}`).join('\n\n')}

Surge containment opens a breaker when an effect type runs far more often than
the ceiling you set. It usually means something is looping. Nothing was
performed twice — the gate held — but work is being held or refused right now.

  ${base()}/console

Manage alerts: ${base()}/console`;

  const html = wrap(subject,
    `<p style="margin:0 0 12px">${global
      ? 'A <strong>workspace-wide stop</strong> is in place.'
      : `<strong>${plural(n, 'circuit breaker')}</strong> opened.`}</p>` +
    rows.map((r) =>
      `<p style="margin:0 0 12px;padding:10px 12px;background:#f6f7f9;border-radius:8px">
         <strong>${esc(r.what)}</strong><br>
         <span style="color:#5b626d">${esc(r.why)}</span><br>
         Now ${esc(r.doing)}; ${esc(r.until)}.
       </p>`).join('') +
    `<p style="margin:0;color:#5b626d">Surge containment opens a breaker when an effect type
       runs far more often than the ceiling you set — usually a loop. Nothing was performed
       twice, but work is being held or refused right now.</p>`,
    { label: 'Review the breaker', href: `${base()}/console` });
  return { subject, text, html };
}

export function usageAlert(remaining: number, included: number, creditMicros: number) {
  const exhausted = remaining === 0;
  const subject = exhausted
    ? 'Your allowance is used up'
    : `${remaining.toLocaleString('en-US')} gated effects left this month`;
  const credit = `$${(creditMicros / 1e6).toFixed(2)}`;
  const text = exhausted
    ? `You have used all ${included.toLocaleString('en-US')} gated effects included this month.

${creditMicros > 0
  ? `Overage is drawing on your ${credit} of prepaid credit.`
  : `With no prepaid credit, NEW effects are being refused with a 402.

Duplicate suppression still works: effects you have already gated keep replaying
their recorded result, so nothing your agents already did can happen twice
because of this.`}

  ${base()}/console

Manage alerts: ${base()}/console`
    : `${remaining.toLocaleString('en-US')} of ${included.toLocaleString('en-US')} included gated effects remain this month.
Prepaid credit: ${credit}.

  ${base()}/console

Manage alerts: ${base()}/console`;

  const html = wrap(subject,
    exhausted
      ? `<p style="margin:0 0 12px">You have used all <strong>${included.toLocaleString('en-US')}</strong> gated effects included this month.</p>
         ${creditMicros > 0
           ? `<p style="margin:0">Overage is drawing on your <strong>${esc(credit)}</strong> of prepaid credit.</p>`
           : `<p style="margin:0 0 12px">With no prepaid credit, <strong>new effects are being refused</strong>.</p>
              <p style="margin:0;color:#5b626d">Duplicate suppression still works — effects you already gated keep replaying their result, so nothing your agents already did can happen twice because of this.</p>`}`
      : `<p style="margin:0"><strong>${remaining.toLocaleString('en-US')}</strong> of ${included.toLocaleString('en-US')} included gated effects remain this month. Prepaid credit: <strong>${credit}</strong>.</p>`,
    { label: exhausted ? 'Add credit' : 'View usage', href: `${base()}/console` });
  return { subject, text, html };
}

export function receipt(amountMicros: number, method: string, balanceMicros: number) {
  const amt = `$${(amountMicros / 1e6).toFixed(2)}`;
  const subject = `Receipt — ${amt} credit added`;
  const text =
`${amt} of prepaid credit was added to your workspace via ${method}.
New balance: $${(balanceMicros / 1e6).toFixed(2)}.

  ${base()}/console

Manage alerts: ${base()}/console`;
  const html = wrap(subject,
    `<p style="margin:0 0 12px"><strong>${esc(amt)}</strong> of prepaid credit was added via ${esc(method)}.</p>
     <p style="margin:0">New balance: <strong>$${(balanceMicros / 1e6).toFixed(2)}</strong>.</p>`,
    { label: 'View ledger', href: `${base()}/console` });
  return { subject, text, html };
}

export function keyCreated(name: string, prefix: string, scopes: string[]) {
  const subject = 'A new API key was created';
  const text =
`An API key named "${name}" (${prefix}…) was created on your workspace.

Scopes: ${scopes.join(', ')}

If this was not you, revoke it now — a key is usable until it is revoked.

  ${base()}/console

Manage alerts: ${base()}/console`;
  const html = wrap(subject,
    `<p style="margin:0 0 12px">An API key named <strong>${esc(name)}</strong> (<code>${esc(prefix)}…</code>) was created on your workspace.</p>
     <p style="margin:0 0 12px;color:#5b626d">Scopes: ${esc(scopes.join(', '))}</p>
     <p style="margin:0"><strong>If this was not you, revoke it now.</strong> A key works until it is revoked.</p>`,
    { label: 'Review API keys', href: `${base()}/console` });
  return { subject, text, html };
}
