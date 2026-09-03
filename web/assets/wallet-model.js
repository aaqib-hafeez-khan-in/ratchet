/**
 * The two rules, as arithmetic.
 *
 * Exported so a test can assert the SHAPE rather than a reader having to trust
 * it. A figure on this page once taught the opposite of what was true, and the
 * only reason anyone found out was that a person said so. The invariant that
 * matters is `dailyOut >= runOut` at every instant: the shaded gap is the
 * argument, and a gap that ever inverted would be an advert for daily ceilings.
 */
export const WALLET = {
  DAYS: 3,
  CAP: 200,            // dollars; both limits are set to the same number on purpose
  WANT_PER_DAY: 340,   // what the stuck agent would spend if nothing stopped it
  TOP: 700,            // y-axis headroom above the daily line's 600

  /** Money out by time t (days) under a ceiling that resets every midnight. */
  dailyOut(t) {
    let total = 0;
    for (let d = 0; d < this.DAYS; d += 1) {
      const inDay = Math.max(0, Math.min(1, t - d));
      total += Math.min(this.CAP, this.WANT_PER_DAY * inDay);
    }
    return total;
  },

  /** Money out by time t under a wallet for the whole run. It never refills. */
  runOut(t) {
    return Math.min(this.CAP, this.WANT_PER_DAY * Math.max(0, t));
  },
};

/**
 * Both lines, drawn.
 *
 * Shared with the landing page rather than reimplemented there, for the reason
 * the other two figures on that page are shared: a compact restatement that
 * quietly disagreed with the full version would be worse than not restating it
 * at all. `compact` drops the axis furniture for a small canvas; the curves,
 * the shading and the colours are the same in both.
 */
export function drawWallet(ctx, w, h, t, colour, { compact = false } = {}) {
  const { DAYS, TOP } = WALLET;
  const padL = compact ? 8 : 52, padR = compact ? 8 : 14;
  const padT = compact ? 10 : 16, padB = compact ? 18 : 30;
  const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;
  const X = (d) => x0 + (d / DAYS) * (x1 - x0);
  const Y = (v) => y1 - (v / TOP) * (y1 - y0);

  ctx.font = '500 10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  ctx.strokeStyle = colour.rule; ctx.lineWidth = 1;
  for (const v of compact ? [0, 200, 600] : [0, 200, 400, 600]) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    if (!compact) {
      ctx.fillStyle = colour.faint; ctx.textAlign = 'right';
      ctx.fillText(`$${v}`, x0 - 8, y);
    }
  }

  // midnights: the whole reason the two lines diverge
  ctx.textAlign = 'center';
  ctx.setLineDash([3, 4]);
  for (let d = 1; d < DAYS; d += 1) {
    const x = Math.round(X(d)) + 0.5;
    ctx.strokeStyle = colour.rule;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    if (t > d - 0.02) {
      ctx.fillStyle = colour.faint;
      ctx.fillText('midnight', x, y1 + (compact ? 9 : 15));
    }
  }
  ctx.setLineDash([]);
  if (!compact) {
    ctx.fillStyle = colour.faint;
    for (let d = 0; d < DAYS; d += 1) ctx.fillText(`day ${d + 1}`, X(d + 0.5), y1 + 15);
  }

  const steps = 220;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const tt = (t * i) / steps;
    pts.push([X(tt), Y(WALLET.dailyOut(tt)), Y(WALLET.runOut(tt))]);
  }
  if (pts.length < 2) return;

  // the gap: money the wallet kept in and the daily ceiling let out
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, yd] of pts) ctx.lineTo(x, yd);
  for (let i = pts.length - 1; i >= 0; i -= 1) ctx.lineTo(pts[i][0], pts[i][2]);
  ctx.closePath();
  ctx.fillStyle = colour.stop; ctx.globalAlpha = 0.13; ctx.fill(); ctx.globalAlpha = 1;

  const line = (idx, c) => {
    ctx.beginPath();
    pts.forEach(([x, ...ys], i) => (i ? ctx.lineTo(x, ys[idx]) : ctx.moveTo(x, ys[idx])));
    ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.beginPath(); ctx.arc(last[0], last[idx + 1], compact ? 2.8 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = c; ctx.fill();
  };
  line(0, colour.stop);      // daily ceiling
  line(1, colour.accent);    // run budget

  if (!compact && t > 0.35) {
    const last = pts[pts.length - 1];
    ctx.textAlign = 'right';
    ctx.fillStyle = colour.stop;
    ctx.fillText('daily ceiling', last[0] - 8, last[1] - 12);
    ctx.fillStyle = colour.accent;
    ctx.fillText('run budget', last[0] - 8, last[2] + 14);
  }
}
