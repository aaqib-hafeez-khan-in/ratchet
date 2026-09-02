/**
 * The numbers the two pages animate.
 *
 * Both the landing page and /benchmark read this one module, so the figures in
 * the prose ("13 duplicate refunds prevented", "$3,120") and the figures the
 * charts count up to cannot drift apart — unless this data stops matching the
 * harness, which is what these check.
 *
 * The animation itself cannot be exercised here, for the reason beat.test.ts
 * gives: requestAnimationFrame is paused and scroll events are not dispatched in
 * a headless pane. What is testable is the arithmetic, and the arithmetic is the
 * claim.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '../../web');
const mod = await import(join(WEB, 'assets/counterfactual.js'));
const { CALLS, JOBS, REFUND, TOTAL_CALLS, DUPLICATES, OVERPAID, tally } = mod;

/** The harness PRNG, reproduced. Any change to either side breaks this. */
function seededRun() {
  let s = 1 >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x1_0000_0000; };
  const calls: number[] = [];
  for (let c = 0; c < 40; c += 1) {
    let n = 0;
    for (let t = 0; t <= 3; t += 1) {
      n += 1;                          // the vendor always performs the work
      if (next() < 0.25) continue;     // response lost; the agent retries
      break;
    }
    calls.push(n);
  }
  return calls;
}

describe('the published run is the run the harness produces', () => {
  test('every lane matches the seeded sequence, not an illustration of one', () => {
    assert.deepEqual([...CALLS], seededRun(),
      'the chart would be animating a story rather than the measurement');
  });

  test('the totals are the ones the page claims', () => {
    assert.equal(JOBS, 40);
    assert.equal(TOTAL_CALLS, 53);
    assert.equal(DUPLICATES, 13);
    assert.equal(OVERPAID, 3120);
    assert.equal(DUPLICATES * REFUND, OVERPAID);
  });

  test('eleven customers were charged more than once, and one four times', () => {
    assert.equal(CALLS.filter((n: number) => n > 1).length, 11);
    assert.equal(Math.max(...CALLS), 4);
  });
});

describe('the scrub never shows a number the run does not reach', () => {
  test('it starts at nothing and ends at the published totals', () => {
    assert.deepEqual(tally(0), { done: 0, ungated: 0, gated: 0, duplicates: 0, overpaid: 0 });
    const end = tally(1);
    assert.equal(end.done, JOBS);
    assert.equal(end.ungated, TOTAL_CALLS);
    assert.equal(end.duplicates, DUPLICATES);
    assert.equal(end.overpaid, OVERPAID);
  });

  test('duplicates and money only ever climb', () => {
    let dup = -1, cash = -1;
    for (let i = 0; i <= 100; i += 1) {
      const t = tally(i / 100);
      assert.ok(t.duplicates >= dup, `duplicates fell at ${i}%`);
      assert.ok(t.overpaid >= cash, `money fell at ${i}%`);
      assert.equal(t.overpaid, t.duplicates * REFUND, 'the two readouts must agree');
      dup = t.duplicates; cash = t.overpaid;
    }
  });

  test('progress outside 0..1 is clamped rather than overrunning the run', () => {
    assert.equal(tally(-5).done, 0);
    assert.equal(tally(9).ungated, TOTAL_CALLS);
  });
});

describe('the pages quote what the module computes', () => {
  const page = readFileSync(join(WEB, 'benchmark.html'), 'utf8');
  const home = readFileSync(join(WEB, 'index.html'), 'utf8');

  test('the benchmark page counts up to the real figures', () => {
    for (const n of ['data-count="53"', 'data-count="40"', 'data-count="3120"']) {
      assert.ok(page.includes(n), `${n} is missing, so the hero would animate to a made-up number`);
    }
    assert.ok(page.includes('$3,120'), 'the prose total is missing');
    assert.ok(page.includes('$12,720.00') && page.includes('$9,600.00'));
  });

  /**
   * The one claim this project must never make. A previous version of that last
   * assertion was vacuous — it passed on any page containing the word "not" —
   * so this one looks at each occurrence in its own sentence.
   */
  test('every mention of exactly-once is a denial of it', () => {
    for (const [name, html] of [['benchmark', page], ['index', home]] as const) {
      for (const m of html.matchAll(/exactly[\s-]once/gi)) {
        const sentence = html.slice(Math.max(0, m.index - 120), m.index + 120);
        assert.match(sentence, /\bnot\b|never|unachievable/i,
          `${name}.html appears to CLAIM exactly-once: ...${sentence.trim()}...`);
      }
    }
  });

  test('the benchmark page says what is guaranteed instead', () => {
    assert.match(page, /at-most-once initiation/);
    assert.match(page, /indeterminate/);
  });

  test('both pages load the same module, so neither can drift', () => {
    assert.ok(readFileSync(join(WEB, 'assets/benchmark.js'), 'utf8')
      .includes('/assets/counterfactual.js'));
    assert.ok(readFileSync(join(WEB, 'assets/home.js'), 'utf8')
      .includes('/assets/counterfactual.js'));
  });
});
