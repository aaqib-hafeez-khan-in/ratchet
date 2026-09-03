import { mountChrome } from '/assets/partials.js';
import { revealSections } from '/assets/reveal.js';
import {
  scrollProgress, onScroll, token, fitted, once, reduced,
  drawContainment, PAYOUT,
} from '/assets/counterfactual.js';

mountChrome('/fraud');
revealSections({ skip: ['.stage'], stagger: 60 });

const $ = (id) => document.getElementById(id);

/* ── the mechanism: a value becomes an identifier, and the identifier counts ──
   The real blinded value from the production check on 2 Sep 2026, so the hex
   settling on screen is the identifier that actually held the $2,000 rather
   than decorative noise. */
const BLINDED = '9eb4dace24bf8589070244228d4a7ea4';
const HEX = '0123456789abcdef';

(() => {
  const stage = $('mechanism');
  if (!stage) return;
  const out = $('blindOut'), fill = $('blindFill'), money = $('blindMoney');
  const op = $('blindOp'), verdict = $('blindVerdict'), input = $('blindIn');

  /**
   * Scramble that is a pure function of progress.
   *
   * Each character settles at its own point in the scroll; before that it cycles
   * through hex on a coarse clock, which reads as computation without ever being
   * random. Scrub backwards and you get the same frames — a chart that changes
   * when you scroll up is a chart nobody trusts.
   */
  const scrambled = (p) => {
    const tick = Math.floor(p * 60);
    let s = '';
    for (let i = 0; i < BLINDED.length; i += 1) {
      const settles = 0.18 + (i / BLINDED.length) * 0.42;
      if (p >= settles) { s += BLINDED[i]; continue; }
      if (p < settles - 0.16) { s += '·'; continue; }
      s += HEX[(i * 7 + tick * 3 + Math.floor(p * 997)) % 16];
    }
    return s;
  };

  onScroll(() => {
    const p = scrollProgress(stage);
    out.textContent = scrambled(p);
    out.classList.toggle('settled', p >= 0.62);
    op.classList.toggle('live', p > 0.14 && p < 0.66);
    input.classList.toggle('faded', p > 0.7);

    // Only once the identifier exists does anything accumulate against it.
    const counting = Math.max(0, Math.min(1, (p - 0.62) / 0.3));
    fill.style.width = `${counting * 100}%`;
    money.textContent = `$${Math.round(counting * 2000).toLocaleString('en-US')}`;
    fill.classList.toggle('full', counting >= 1);
    verdict.textContent = counting >= 1
      ? 'The ceiling is reached. Ratchet still cannot say where the money went.'
      : p >= 0.62
        ? 'Counting against a $2,000 daily ceiling.'
        : p > 0.14 ? 'Keyed hash. Not reversible, and not comparable across workspaces.' : ' ';
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

/* ── the walls a compromised agent hits ──────────────────────────────────── */
(() => {
  const list = $('walls');
  if (!list) return;
  const items = [...list.children];
  once(list, () => {
    items.forEach((el, i) =>
      setTimeout(() => el.classList.add('hit'), reduced() ? 0 : 260 + i * 380));
  });
})();
