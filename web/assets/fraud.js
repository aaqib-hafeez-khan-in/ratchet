import { mountChrome } from '/assets/partials.js';
import { revealSections } from '/assets/reveal.js';
import {
  scrollProgress, onScroll, token, fitted, once, reduced,
  drawContainment, PAYOUT,
} from '/assets/counterfactual.js';
import { WALLET, drawWallet } from '/assets/wallet-model.js';

mountChrome('/fraud');
revealSections({ skip: ['.stage'], stagger: 60 });

const $ = (id) => document.getElementById(id);

/* ── the mechanism: a redacted statement ─────────────────────────────────
   A reader read the old version of this and concluded Ratchet "never knows the
   amount it needs to stop at", which is the opposite of true and made the whole
   thing sound like magic. The amount is not hidden and cannot be — adding it up
   is the job. Only WHO is hidden.

   So the picture is a bank statement with the payee column redacted and the
   amounts perfectly legible. Nobody needs that explained. */
const BLINDED = '9eb4dace24bf8589070244228d4a7ea4';   // the real one, from the live check
const HEX = '0123456789abcdef';
const PAYMENT = 500, CEILING = 2000;
const ROWS = 5;

(() => {
  const stage = $('mechanism'), host = $('ledgerRows');
  if (!stage || !host) return;
  const total = $('ledgerTotal'), cap = $('ledgerCap'), verdict = $('blindVerdict');

  host.innerHTML = Array.from({ length: ROWS }, (_, i) => `
    <div class="ledger-row" data-i="${i}">
      <code class="ledger-who"></code>
      <span class="ledger-amt">$${PAYMENT.toLocaleString('en-US')}</span>
      <span class="ledger-mark"></span>
    </div>`).join('');
  const rows = [...host.children];

  /** Hex that is a pure function of progress, so scrubbing back gives the same frames. */
  const redacted = (p, i) => {
    const settle = Math.max(0, Math.min(1, (p - 0.1 - i * 0.055) / 0.12));
    if (settle <= 0) return '';
    const tick = Math.floor(p * 90);
    let out = '';
    for (let c = 0; c < BLINDED.length; c += 1) {
      out += c / BLINDED.length <= settle
        ? BLINDED[c]
        : HEX[(c * 7 + tick * 3 + i * 11) % 16];
    }
    return out;
  };

  onScroll(() => {
    const p = scrollProgress(stage);
    let shown = 0;

    rows.forEach((row, i) => {
      // Each row arrives, its payee redacts, and only then does it count.
      const arrive = Math.max(0, Math.min(1, (p - i * 0.055) / 0.09));
      row.classList.toggle('in', arrive > 0);
      row.style.opacity = String(arrive);
      const who = row.querySelector('.ledger-who');
      who.textContent = redacted(p, i);
      who.classList.toggle('sealed', p > 0.1 + i * 0.055 + 0.12);

      if (arrive >= 1) shown += 1;
    });

    const permitted = Math.min(shown, Math.floor(CEILING / PAYMENT));
    rows.forEach((row, i) => {
      const over = i >= Math.floor(CEILING / PAYMENT) && row.style.opacity === '1';
      row.classList.toggle('refused', over);
      const mark = row.querySelector('.ledger-mark');
      mark.textContent = over ? 'refused' : (row.style.opacity === '1' ? 'ok' : '');
    });

    const sum = permitted * PAYMENT;
    total.textContent = `$${sum.toLocaleString('en-US')}`;
    total.classList.toggle('at-cap', sum >= CEILING);
    cap.textContent = sum >= CEILING ? 'ceiling reached' : `ceiling $${CEILING.toLocaleString('en-US')}`;

    verdict.textContent = shown > Math.floor(CEILING / PAYMENT)
      ? 'Ratchet added those up without ever being able to read the left-hand column.'
      : shown > 0
        ? 'The amounts are in the clear. The account is a keyed hash and cannot be reversed.'
        : ' ';
  });
})();

/* ── the ceiling holding: twenty attempts, one destination ──────────────── */
(() => {
  const stage = $('ceiling'), canvas = $('ceilCanvas');
  if (!stage || !canvas) return;
  const draw = fitted(canvas);
  const out = { tried: $('ceilTried'), ok: $('ceilOk'), no: $('ceilNo'),
                held: $('ceilHeld'), hint: $('ceilHint') };

  onScroll(() => {
    const p = scrollProgress(stage);
    let seen = { tried: 0, landed: 0 };
    draw((ctx, w, h) => {
      seen = drawContainment(ctx, w, h, p, {
        gate: token('--accent', '#1c5cff'),
        stop: token('--stop', '#b0341f'),
        rule: token('--border', '#e3e6ea'),
        dim: token('--text-faint', '#868d99'),
      });
    });
    const permitted = Math.min(seen.tried, PAYOUT.allowed);
    const refused = Math.max(0, seen.tried - PAYOUT.allowed);
    out.tried.textContent = String(seen.tried);
    out.ok.textContent = String(permitted);
    out.no.textContent = String(refused);
    out.held.textContent = `$${(refused * PAYOUT.each).toLocaleString('en-US')}`;
    out.hint.textContent = seen.tried >= PAYOUT.attempts
      ? 'ceiling held' : `${seen.tried} of ${PAYOUT.attempts}`;
  });
})();

/* ── the wallet that never refills ───────────────────────────────────────
   Two cumulative lines over three days, from the same stuck agent.

   The point is the SHAPE, not either number. A daily ceiling draws a staircase:
   it refuses, and then midnight hands the allowance back and it refuses again
   tomorrow, having let the same money out a second time. A run budget draws a
   plateau. The gap between the lines is the whole argument, so it is shaded and
   counted rather than left for the reader to infer.

   Both are the arithmetic of the two rules. Neither is a measurement. */
(() => {
  const stage = $('wallet'), canvas = $('walCanvas');
  if (!stage || !canvas) return;
  const draw = fitted(canvas);
  const out = { day: $('walDay'), daily: $('walDaily'), run: $('walRun'),
                gap: $('walGap'), hint: $('walHint') };
  const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

  onScroll(() => {
    const t = Math.max(0, Math.min(WALLET.DAYS, scrollProgress(stage) * WALLET.DAYS));
    draw((ctx, w, h) => drawWallet(ctx, w, h, t, {
      rule: token('--border', '#e3e6ea'),
      faint: token('--text-faint', '#868d99'),
      stop: token('--stop', '#b0341f'),
      accent: token('--accent', '#1c5cff'),
    }));

    const d = WALLET.dailyOut(t), r = WALLET.runOut(t);
    out.day.textContent = String(Math.min(WALLET.DAYS, Math.floor(t) + 1));
    out.daily.textContent = money(d);
    out.run.textContent = money(r);
    out.gap.textContent = money(d - r);
    out.hint.textContent = t >= WALLET.DAYS ? 'three days later' : 'scroll';
  });
})();

/* ── the walls a compromised agent hits ──────────────────────────────────── */
for (const id of ['walls', 'controls']) {
  const list = $(id);
  if (!list) continue;
  const items = [...list.children];
  once(list, () => {
    items.forEach((el, i) =>
      setTimeout(() => el.classList.add('hit'), reduced() ? 0 : 260 + i * 380));
  });
}

/* ── structuring: the two bands counting up ──────────────────────────────
   The numbers are the ones in the worked example beside it, and the point of
   the animation is the contrast between them rather than either figure. */
(() => {
  const wrap = $('bands');
  if (!wrap) return;
  const hug = $('bandHug'), control = $('bandControl'), verdict = $('bandVerdict');
  const HUG = 23, CONTROL = 2;

  once(wrap, () => {
    if (reduced()) {
      hug.textContent = String(HUG); control.textContent = String(CONTROL);
      verdict.textContent = `${(HUG / CONTROL).toFixed(1)}x as many pressed against the line.`;
      return;
    }
    const t0 = Date.now(), dur = 1400;
    const tick = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / dur);
      const eased = 1 - (1 - k) ** 3;
      hug.textContent = String(Math.round(HUG * eased));
      control.textContent = String(Math.round(CONTROL * eased));
      if (k >= 1) {
        clearInterval(tick);
        verdict.textContent = `${(HUG / CONTROL).toFixed(1)}x as many pressed against the line. `
          + 'Amounts do not normally do that.';
      }
    }, 32);
    setTimeout(() => {
      clearInterval(tick);
      hug.textContent = String(HUG); control.textContent = String(CONTROL);
    }, dur + 400);
  });
})();
