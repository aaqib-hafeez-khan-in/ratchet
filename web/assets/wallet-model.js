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
