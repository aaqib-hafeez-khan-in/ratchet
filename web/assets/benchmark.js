// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { mountChrome } from '/assets/partials.js';
import { revealSections } from '/assets/reveal.js';
import {
  CALLS, JOBS, DUPLICATES, OVERPAID, REFUND,
  scrollProgress, onScroll, token, fitted, drawLanes, tally, money, countUp, once, reduced,
} from '/assets/counterfactual.js';

mountChrome('/benchmark');
// The pinned sections animate themselves; a reveal fade on top of a scrub reads
// as two things fighting over the same pixels.
revealSections({ skip: ['.stage'], stagger: 60 });

const $ = (id) => document.getElementById(id);

/* ── headline figures ───────────────────────────────────────────────────── */
for (const el of document.querySelectorAll('[data-count]')) {
  countUp(el, Number(el.dataset.count), { prefix: el.dataset.prefix || '' });
}

/* ── the run: forty jobs, scrubbed by scroll ────────────────────────────── */
(() => {
  const stage = $('run'), canvas = $('lanes');
  if (!stage || !canvas) return;
  const draw = fitted(canvas);
  const out = { un: $('tUn'), ga: $('tGa'), dup: $('tDup'), money: $('tMoney'), hint: $('runHint') };

  onScroll(() => {
    const p = scrollProgress(stage);
    draw((ctx, w, h) => drawLanes(ctx, w, h, p, {
      quiet: token('--text-faint', '#868d99'),
      leak: token('--stop', '#b0341f'),
      gate: token('--accent', '#1c5cff'),
    }));
    const t = tally(p);
    out.un.textContent = String(t.ungated);
    out.ga.textContent = String(t.gated);
    out.dup.textContent = String(t.duplicates);
    out.money.textContent = money(t.overpaid);
    out.hint.textContent = t.done >= JOBS ? `${JOBS} of ${JOBS} · complete` : `${t.done} of ${JOBS}`;
  });
})();

/* ── the money, stacked ─────────────────────────────────────────────────── */
(() => {
  const stage = $('stack'), bars = $('stackBars');
  if (!stage || !bars) return;

  // One block per duplicate refund, labelled with the customer it belongs to, so
  // the stack is the actual thirteen rather than a decorative thirteen.
  const blocks = [];
  for (let j = 0; j < JOBS; j += 1) {
    for (let k = 1; k < CALLS[j]; k += 1) blocks.push(j + 1);
  }
  bars.innerHTML = blocks
    .map((customer) => `<i class="blk" data-c="${customer}"><b>customer ${customer}</b></i>`)
    .join('');
  const els = [...bars.children];
  const total = $('stackTotal'), note = $('stackNote');

  onScroll(() => {
    const p = scrollProgress(stage);
    const lit = Math.round(p * blocks.length);
    els.forEach((el, i) => el.classList.toggle('on', i < lit));
    total.textContent = money(lit * REFUND);
    note.textContent = lit >= blocks.length
      ? `${DUPLICATES} duplicate refunds, ${new Set(blocks).size} customers affected`
      : `${lit} of ${DUPLICATES}`;
  });
})();

/* ── the race: two requests, in real time ───────────────────────────────── */
(() => {
  const stage = $('race');
  if (!stage) return;
  const BEFORE = 1428, AFTER = 117;                 // p95 milliseconds, measured
  const before = $('raceBefore'), after = $('raceAfter');
  const msB = $('msBefore'), msA = $('msAfter'), verdict = $('raceVerdict');

  /**
   * Scroll drives a clock, not a width. Both bars advance against the SAME
   * elapsed milliseconds, which is the whole point: the fast one finishes and
   * then sits there, visibly waiting, while the slow one is still going.
   */
  onScroll(() => {
    const elapsed = scrollProgress(stage) * BEFORE;
    const b = Math.min(1, elapsed / BEFORE);
    const a = Math.min(1, elapsed / AFTER);
    before.style.width = `${b * 100}%`;
    after.style.width = `${a * 100}%`;
    msB.textContent = `${Math.round(b * BEFORE)} ms`;
    msA.textContent = `${Math.round(a * AFTER)} ms`;
    after.classList.toggle('done', a >= 1);
    verdict.textContent = a >= 1 && b < 1
      ? `finished — still waiting on the old one for another ${Math.round(BEFORE - elapsed)} ms`
      : b >= 1 ? `1428 ms → 117 ms · about 12×` : ' ';
  });
})();

/* ── round trips removed ────────────────────────────────────────────────── */
(() => {
  const wrap = $('trips'), label = $('tripsLabel');
  if (!wrap) return;
  const BEFORE = 16, AFTER = 9;
  wrap.innerHTML = Array.from({ length: BEFORE },
    (_, i) => `<i class="trip${i >= AFTER ? ' cut' : ''}"></i>`).join('');
  const cut = [...wrap.querySelectorAll('.cut')];

  once(wrap, () => {
    if (reduced()) { cut.forEach((el) => el.classList.add('gone')); label.textContent = '9'; return; }
    cut.forEach((el, i) => setTimeout(() => {
      el.classList.add('gone');
      label.textContent = String(BEFORE - (i + 1));
    }, 420 + i * 110));
  });
})();

/* ── latency bars ───────────────────────────────────────────────────────── */
(() => {
  const group = $('latency');
  if (!group) return;
  once(group, () => {
    group.querySelectorAll('.bar-fill').forEach((f, i) => {
      setTimeout(() => { f.style.width = `${f.dataset.pct}%`; }, reduced() ? 0 : i * 130);
    });
  });
})();

/* The page states $3,120 in three places; if the arithmetic ever disagrees with
   the prose, that is a bug worth seeing in the console rather than shipping. */
if (DUPLICATES * REFUND !== OVERPAID) {
  console.error('benchmark: duplicate arithmetic disagrees with the published total');
}
