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

describe('the containment picture is arithmetic, not a claim', () => {
  const { PAYOUT } = mod;

  test('the numbers on the page are the rule applied', () => {
    assert.equal(PAYOUT.allowed, Math.floor(PAYOUT.ceiling / PAYOUT.each));
    assert.equal(PAYOUT.allowed, 4);
    assert.equal((PAYOUT.attempts - PAYOUT.allowed) * PAYOUT.each, 8000,
      'the $8,000 both pages show is 16 refused attempts, not a measurement');
  });

  test('both pages say it is the rule and not a benchmark', () => {
    const fraud = readFileSync(join(WEB, 'fraud.html'), 'utf8');
    const home = readFileSync(join(WEB, 'index.html'), 'utf8');
    assert.match(fraud, /not a measurement of anything else|rule continued/i,
      'fraud.html must not let the arithmetic read as a measured result');
    // The landing page block links to the page that explains it rather than
    // repeating the caveat in a space too small to hold it.
    assert.ok(home.includes('href="/fraud"'));
  });

  test('the blinded value shown is the one from the live check', () => {
    const js = readFileSync(join(WEB, 'assets/fraud.js'), 'utf8');
    assert.match(js, /9eb4dace24bf8589070244228d4a7ea4/,
      'the hex settling on screen should be the identifier that really held the $2,000');
  });
});

describe('the mechanism section says which half is hidden', () => {
  const fraud = readFileSync(join(WEB, 'fraud.html'), 'utf8');

  /**
   * A reader of the first version concluded that Ratchet "never knows the amount
   * it needs to stop at" — the opposite of true, and it made the whole thing
   * sound like magic. The amount cannot be hidden; adding it up is the job. Only
   * who is hidden. The page now has to keep saying so.
   */
  test('it states plainly that the amount is not hidden', () => {
    assert.match(fraud, /always knows how much/i,
      'the heading has to carry the correction, because that is what gets read');
    assert.match(fraud, /amount<\/strong> is not\s*\n?\s*hidden|amount<\/strong> is not hidden/i,
      'the body must say the amount is not hidden, in those words');
  });

  test('it says what IS hidden in plain language, not only as "destination"', () => {
    assert.match(fraud, /who the money is going to/i,
      '"destination" was the word a reader said they did not understand');
    assert.match(fraud, /who it is going to/i, 'and the diagram must be labelled the same way');
  });

  test('the ledger shows both columns, so the contrast is the picture', () => {
    const js = readFileSync(join(WEB, 'assets/fraud.js'), 'utf8');
    assert.match(js, /ledger-who/, 'the redacted column');
    assert.match(js, /ledger-amt/, 'the legible one');
    assert.match(js, /const PAYMENT = 500, CEILING = 2000/,
      'the amounts on screen are the ones the ceiling is stated in');
  });
});

describe('the fraud page covers the controls that exist', () => {
  const fraud = readFileSync(join(WEB, 'fraud.html'), 'utf8');

  /** Each of these ships, and each was described nowhere on the site. */
  for (const [what, probe] of [
    ['run budgets', /runs\/\{run_id\}\/budget/],
    ['surge containment', /surge_per_hour/],
    ['agent reliability', /agents\/\{agent_id\}\/reliability/],
    ['reconciliation', /v1\/reconcile/],
    ['signed receipts', /Ed25519/],
  ] as const) {
    test(`${what} is on the page`, () => assert.match(fraud, probe));
  }

  test('it names who it is for, and who it is not for', () => {
    assert.match(fraud, /refund and promo abuse/i, 'retail');
    assert.match(fraud, /payouts, batches, sweeps/i, 'banking');
    assert.match(fraud, /will not compete on inbound fraud/i,
      'the boundary has to be as loud as the pitch');
    assert.match(fraud, /no third-party audit/i);
    assert.match(fraud, /one operator/i);
  });
});

describe('the fraud page claims only what is built', () => {
  const fraud = readFileSync(join(WEB, 'fraud.html'), 'utf8');

  /** Things discussed as possible must not read as shipped. */
  test('unbuilt detection is named as unbuilt', () => {
    // 'structuring' came off this list when it shipped, which is the only way an
    // item should ever leave it.
    for (const unbuilt of ['fan-in', 'fan-out', 'scheduled reconciliation']) {
      if (!fraud.toLowerCase().includes(unbuilt)) continue;
      const at = fraud.toLowerCase().indexOf(unbuilt);
      const around = fraud.slice(Math.max(0, at - 400), at + 400).toLowerCase();
      assert.match(around, /not built|are not claimed|until they exist/,
        `"${unbuilt}" appears without saying it does not exist yet`);
    }
  });

  test('it leads with the boundary rather than burying it', () => {
    assert.match(fraud, /A control, not a detector/);
    assert.match(fraud, /never tell you a payment is fraudulent/);
    assert.match(fraud, /cannot score a transaction/i);
  });

  test('structuring is described as built, and as a hint', () => {
    assert.match(fraud, /analysis\/structuring/, 'the endpoint has to be named');
    assert.match(fraud, /structuring_threshold_micros/,
      'and the way to point it at a line we do not enforce');
    assert.match(fraud, /a cap produces this bunching all by itself/i,
      'the false positive is the first thing a reader should be told about');
    assert.match(fraud, /somewhere to\s*\n?\s*look/i,
      'a bunching count is not a finding of fraud and the page must not imply it is');
  });

  test('it does not claim exactly-once anywhere', () => {
    for (const m of fraud.matchAll(/exactly[\s-]once/gi)) {
      const sentence = fraud.slice(Math.max(0, m.index - 120), m.index + 120);
      assert.match(sentence, /\bnot\b|never/i, `possible exactly-once claim: ${sentence}`);
    }
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
