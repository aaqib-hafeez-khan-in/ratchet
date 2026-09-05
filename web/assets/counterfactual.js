// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The benchmark run, as motion.
 *
 * Shared by the landing page and /benchmark so there is one implementation of
 * the numbers and one of the drawing. Both pages tell the same story at
 * different lengths; neither should be able to drift from the other.
 *
 * Everything here follows the same rules as reveal.js, for the same reasons:
 *
 *   Nothing depends on requestAnimationFrame. It is paused in a hidden tab,
 *   during prerender, and under power saving. A chart that only draws if rAF
 *   cooperates is a chart that is sometimes an empty box.
 *
 *   A degenerate viewport draws the finished state, not an empty one. If the
 *   scroll span cannot be measured, the reader still sees the result.
 *
 *   Reduced motion goes straight to the end. The story is the numbers, and the
 *   numbers are all present without any of the movement.
 */

/**
 * The real seeded run, reproduced from the harness PRNG:
 * s = (s * 1664525 + 1013904223) mod 2^32, seed 1, response lost when
 * s / 2^32 < 0.25. Each entry is how many times the vendor actually performed
 * that customer's refund with nothing gating it.
 *
 * Sum is 53 for 40 customers. Eleven were refunded more than once, and one was
 * refunded four times.
 */
export const CALLS = [
  2, 1, 1, 2, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 4, 2, 1, 1,
  1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 2, 2, 1, 1, 2,
];
export const JOBS = CALLS.length;          // 40
export const REFUND = 240;                 // dollars, each
export const TOTAL_CALLS = CALLS.reduce((a, n) => a + n, 0);   // 53
export const DUPLICATES = TOTAL_CALLS - JOBS;                  // 13
export const OVERPAID = DUPLICATES * REFUND;                   // 3120

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * How far through a pinned section the reader is, 0 to 1.
 *
 * Returns 1 when the span cannot be measured — a collapsed viewport, a renderer
 * that reports no height — because a finished chart is a better failure than a
 * blank one.
 */
export function scrollProgress(el, overshoot = 1.08) {
  if (reduced()) return 1;
  const r = el.getBoundingClientRect();
  const span = r.height - innerHeight;
  if (!(span > 8)) return 1;
  return Math.max(0, Math.min(1, (-r.top / span) * overshoot));
}

/** Repaint on scroll and resize at roughly 60Hz, without rAF. */
export function onScroll(fn) {
  let last = 0;
  const run = () => {
    const now = Date.now();
    if (now - last < 16) return;
    last = now;
    fn();
  };
  addEventListener('scroll', run, { passive: true });
  addEventListener('resize', () => { last = 0; fn(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { last = 0; fn(); });
  addEventListener('load', () => { last = 0; fn(); });
  fn();
  return run;
}

/** Read a CSS custom property, with a literal fallback if the sheet has not landed. */
export function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * A canvas that keeps its backing store in step with its CSS size.
 * Returns a draw(fn) that hands the callback a context already scaled to CSS
 * pixels, plus the width and height in those pixels.
 */
export function fitted(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0;
  const measure = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (!r.width || !r.height) return false;
    if (r.width !== w || r.height !== h) {
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  };
  return (fn) => {
    if (!measure()) return;
    ctx.clearRect(0, 0, w, h);
    fn(ctx, w, h);
  };
}

/**
 * The two runs, lane by lane.
 *
 * One row per customer. On the ungated side a mark appears for every refund the
 * vendor actually performed, and every mark after the first is money that left
 * twice. On the gated side there is exactly one, always.
 */
export function drawLanes(ctx, w, h, p, colors) {
  const laneH = h / JOBS;
  const markH = Math.max(2, Math.min(laneH - 1.5, 6));
  const most = Math.max(...CALLS);                    // 4: the worst customer

  // Lay the two runs out as one composition rather than two halves. The ungated
  // side needs room for its worst row and no more; giving it half the canvas
  // leaves a void where the comparison should be, and the eye has to travel to
  // find the other column.
  const gap = Math.min(56, Math.max(20, w * 0.07));
  const markW = Math.min(22, Math.max(6, (w - gap) / (most + 3)));
  const ungatedW = most * (markW + 1);
  const total = ungatedW + gap + markW;
  const x0 = Math.max(0, (w - total) / 2);
  const gatedX = x0 + ungatedW + gap;
  const shown = p * JOBS;

  for (let j = 0; j < JOBS; j += 1) {
    const local = Math.max(0, Math.min(1, shown - j));
    if (local <= 0) continue;
    const y = j * laneH + (laneH - markH) / 2;

    const n = CALLS[j];
    for (let k = 0; k < n; k += 1) {
      const a = Math.max(0, Math.min(1, local * n - k));
      if (a <= 0) break;
      ctx.globalAlpha = a;
      // The first call is the one that should have happened; everything after
      // it is money that moved twice, and only that gets the alarming colour.
      ctx.fillStyle = k === 0 ? colors.quiet : colors.leak;
      ctx.fillRect(x0 + k * (markW + 1), y, markW * a, markH);
    }

    ctx.globalAlpha = local;
    ctx.fillStyle = colors.gate;
    ctx.fillRect(gatedX, y, markW * local, markH);
  }
  ctx.globalAlpha = 1;
}

/** The running totals at a given progress, so text and chart never disagree. */
export function tally(p) {
  const done = Math.max(0, Math.min(JOBS, Math.floor(p * JOBS + 1e-9)));
  let ungated = 0;
  for (let j = 0; j < done; j += 1) ungated += CALLS[j];
  return { done, ungated, gated: done, duplicates: ungated - done,
           overpaid: (ungated - done) * REFUND };
}

export const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

/**
 * Count a number up once, on a timer rather than rAF, and guarantee the true
 * figure lands whatever happens to the timer.
 */
export function countUp(el, to, { prefix = '', ms = 1100 } = {}) {
  const final = prefix + Math.round(to).toLocaleString('en-US');
  if (reduced()) { el.textContent = final; return; }
  const t0 = Date.now();
  el.textContent = prefix + '0';
  const tick = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / ms);
    el.textContent = prefix + Math.round(to * (1 - (1 - k) ** 3)).toLocaleString('en-US');
    if (k >= 1) clearInterval(tick);
  }, 32);
  setTimeout(() => { clearInterval(tick); el.textContent = final; }, ms + 400);
}

/**
 * Run `fn` once, the first time `el` is near the viewport.
 *
 * Deliberately not an IntersectionObserver, for the reason reveal.js gives: an
 * observer that never fires leaves the page holding its breath forever. A plain
 * sweep on scroll decides, and a backstop runs it regardless.
 */
export function once(el, fn) {
  let done = false;
  const fire = () => { if (done) return; done = true; fn(); };
  if (reduced()) { fire(); return; }
  const check = () => {
    if (done) return;
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight * 0.9 && r.bottom > 0) fire();
  };
  addEventListener('scroll', check, { passive: true });
  addEventListener('resize', check, { passive: true });
  check();
  setTimeout(check, 500);
  setTimeout(fire, 4000);       // never leave a figure sitting at zero
}

/**
 * Twenty payouts at one destination, against a ceiling.
 *
 * Permitted attempts cross the gate and land. Refused ones stop dead on it,
 * which is the entire point of the picture: the money does not reach the other
 * side, so there is nothing at the vendor to undo.
 *
 * The arithmetic is the rule applied — floor(ceiling / each) get through — not a
 * measurement, and both pages say so in the text beside it.
 */
export const PAYOUT = { attempts: 20, each: 500, ceiling: 2000 };
PAYOUT.allowed = Math.floor(PAYOUT.ceiling / PAYOUT.each);

export function drawContainment(ctx, w, h, p, colors) {
  const { attempts, allowed } = PAYOUT;
  const originX = Math.max(26, w * 0.08);
  const gateX = Math.round(w * 0.46) + 0.5;      // half pixel: a crisp 1px rule
  const destX = Math.min(w - 26, w * 0.88);
  const midY = h * 0.5;
  // Reserve the label band before deciding how far the lanes may spread. Sizing
  // the spread off raw height put the labels past the bottom edge of a short
  // canvas — so on a phone, where the picture needs them most, they were the
  // one thing not drawn.
  const labelBand = 18;
  const spread = Math.min((h - labelBand * 2) * 0.44, 132);
  const label = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';

  // The gate. Drawn first and drawn plainly: everything else is arranged around
  // the fact that this line is where a decision happens.
  ctx.strokeStyle = colors.gate;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gateX, midY - spread - 16);
  ctx.lineTo(gateX, midY + spread + 16);
  ctx.stroke();
  ctx.globalAlpha = 1;

  let tried = 0, landed = 0;
  for (let i = 0; i < attempts; i += 1) {
    const t = Math.max(0, Math.min(1, (p - i * (0.6 / attempts)) / 0.3));
    if (t <= 0) continue;
    tried += 1;

    const permitted = i < allowed;
    const fromY = midY + ((i / (attempts - 1)) - 0.5) * 2 * spread;
    const stopX = permitted ? destX : gateX;
    const x = originX + (stopX - originX) * t;
    const reach = permitted ? t : t * (gateX - originX) / (destX - originX);
    const y = fromY + (midY - fromY) * reach;

    ctx.globalAlpha = permitted ? 0.9 : 0.45;
    ctx.strokeStyle = permitted ? colors.gate : colors.dim;
    ctx.lineWidth = permitted ? 1.6 : 1;
    ctx.beginPath(); ctx.moveTo(originX, fromY); ctx.lineTo(x, y); ctx.stroke();
    ctx.globalAlpha = 1;

    if (permitted) {
      ctx.fillStyle = colors.gate;
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
      if (t >= 1) landed += 1;
    } else if (t >= 1) {
      // Stopped, not travelling: a short bar against the gate rather than a dot,
      // so a refusal looks like an impact and not like an arrival.
      ctx.fillStyle = colors.stop;
      ctx.fillRect(gateX - 4, y - 1.5, 8, 3);
    } else {
      ctx.fillStyle = colors.dim;
      ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // The destination, filling to its ceiling and no further.
  const barH = Math.min(h * 0.46, 116), barW = 12;
  const level = Math.min(1, landed / allowed);
  ctx.fillStyle = colors.rule;
  ctx.fillRect(destX - barW / 2, midY - barH / 2, barW, barH);
  ctx.fillStyle = colors.gate;
  ctx.fillRect(destX - barW / 2, midY + barH / 2 - barH * level, barW, barH * level);
  ctx.strokeStyle = level >= 1 ? colors.stop : colors.dim;
  ctx.lineWidth = level >= 1 ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(destX - barW - 7, midY - barH / 2);
  ctx.lineTo(destX + barW + 7, midY - barH / 2);
  ctx.stroke();

  // Labels, so the picture explains itself without the caption.
  ctx.font = label;
  ctx.fillStyle = colors.dim;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('your agent', originX - 2, midY + spread + 14);
  ctx.textAlign = 'center';
  ctx.fillStyle = colors.gate;
  ctx.fillText('ratchet', gateX, midY + spread + 14);
  ctx.fillStyle = colors.dim;
  ctx.textAlign = 'right';
  ctx.fillText('one account', Math.min(w - 2, destX + barW + 7), midY + spread + 14);
  ctx.textAlign = 'left';

  return { tried, landed };
}
