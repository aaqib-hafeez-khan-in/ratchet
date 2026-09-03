/**
 * The figure on /fraud that argues for run budgets.
 *
 * A reader once looked at an animation on this page and drew the opposite
 * conclusion from the one it was drawing, and the only reason anyone found out
 * was that they said so. A figure is an argument; an argument that quietly
 * inverts is worse than no figure, because it is persuasive.
 *
 * So the shape is asserted rather than eyeballed. The claim being made is
 * narrow and checkable: a daily ceiling hands the allowance back every midnight,
 * a run budget never does, and therefore the daily line can only ever be at or
 * above the run line. If that ever inverted, the page would be an advert for
 * daily ceilings drawn in Ratchet's own colours.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Loaded as text and evaluated: the browser module has no Node entry point. */
const WALLET = await (async () => {
  const src = readFileSync(new URL('../../web/assets/wallet-model.js', import.meta.url), 'utf8');
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  return mod.WALLET as {
    DAYS: number; CAP: number; WANT_PER_DAY: number; TOP: number;
    dailyOut(t: number): number; runOut(t: number): number;
  };
})();

const { DAYS, CAP } = WALLET;
const daily = (t: number) => WALLET.dailyOut(t);
const run = (t: number) => WALLET.runOut(t);
const everyInstant = Array.from({ length: 601 }, (_, i) => (i / 600) * DAYS);

describe('the argument the figure makes', () => {
  test('the run budget never lets more out than the daily ceiling', () => {
    for (const t of everyInstant) {
      assert.ok(daily(t) >= run(t) - 1e-9,
        `at t=${t.toFixed(3)} the run budget let out ${run(t)} against the daily `
        + `ceiling's ${daily(t)} — the figure would be arguing the opposite of its caption`);
    }
  });

  test('a run budget never refills, so it can never exceed its ceiling', () => {
    for (const t of everyInstant) {
      assert.ok(run(t) <= CAP + 1e-9, `run budget let out ${run(t)} past a ${CAP} ceiling`);
    }
    assert.equal(run(DAYS), CAP, 'and it does reach it, or the figure shows nothing');
  });

  test('the daily ceiling does refill, once per midnight', () => {
    // The whole argument. Three days, three allowances.
    assert.equal(Math.round(daily(DAYS)), CAP * DAYS);
    for (let d = 1; d < DAYS; d += 1) {
      assert.ok(daily(d + 0.5) > daily(d),
        `nothing more went out after midnight ${d}, so the reset is not visible`);
    }
  });

  test('both are identical until the first ceiling is reached', () => {
    // Before either limit bites, the lines must sit on top of each other — the
    // gap has to open because of the RESET, not because the two rules started
    // out different.
    for (const t of [0, 0.1, 0.25, 0.4, CAP / WALLET.WANT_PER_DAY]) {
      assert.equal(daily(t).toFixed(6), run(t).toFixed(6),
        `at t=${t} the lines already differ, which blames the wrong mechanism`);
    }
  });

  test('neither line ever goes backwards', () => {
    for (const f of [daily, run]) {
      let prev = -1;
      for (const t of everyInstant) {
        const v = f(t);
        assert.ok(v >= prev - 1e-9, 'money already spent cannot un-spend itself');
        prev = v;
      }
    }
  });

  test('nothing is spent before the run starts', () => {
    assert.equal(daily(0), 0);
    assert.equal(run(0), 0);
    assert.equal(run(-1), 0, 'and time before the start is not negative spend');
  });

  test('the axis fits the taller line, or the figure clips', () => {
    assert.ok(WALLET.TOP > daily(DAYS),
      'the daily line would run off the top of the chart');
  });

  test('the stuck agent genuinely outspends both limits, or nothing is demonstrated', () => {
    assert.ok(WALLET.WANT_PER_DAY > CAP,
      'if the agent wanted less than the cap, neither limit would ever bite '
      + 'and the figure would show two flat lines agreeing');
  });
});

describe('both pages tell the same story', () => {
  const home = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const fraud = readFileSync(new URL('../../web/fraud.html', import.meta.url), 'utf8');
  const homeJs = readFileSync(new URL('../../web/assets/home.js', import.meta.url), 'utf8');
  const fraudJs = readFileSync(new URL('../../web/assets/fraud.js', import.meta.url), 'utf8');

  test('the landing page draws from the same module, not its own copy', () => {
    for (const [name, js] of [['home.js', homeJs], ['fraud.js', fraudJs]] as const) {
      assert.match(js, /wallet-model\.js/,
        `${name} should import the shared model — a restatement that quietly disagreed `
        + 'with the full version would be worse than not restating it');
      assert.match(js, /drawWallet/, `${name} should use the shared renderer`);
    }
  });

  test('the landing legend is seeded with the numbers the model ends on', () => {
    // Those two values sit in the HTML as literals so the figure reads correctly
    // before any script runs. Literals drift; the model is the truth.
    const seeded = (id: string) =>
      home.match(new RegExp(`id="${id}"[^>]*>\\$([\\d,]+)<`))?.[1]?.replace(/,/g, '');
    assert.equal(Number(seeded('homeWalDaily')), Math.round(daily(DAYS)),
      'the daily figure printed before the script runs is not where the line ends');
    assert.equal(Number(seeded('homeWalRun')), Math.round(run(DAYS)),
      'the run figure printed before the script runs is not where the line ends');
  });

  test('both pages name the ceiling the figure is drawn against', () => {
    for (const [name, html] of [['index.html', home], ['fraud.html', fraud]] as const) {
      assert.ok(html.includes(`$${CAP}`),
        `${name} draws a $${CAP} ceiling but never says so in words`);
    }
  });

  test('the landing page sends the reader to the full version', () => {
    assert.match(home, /href="\/fraud#wallet"/,
      'the compact figure makes a claim it does not have room to justify');
    assert.match(fraud, /id="wallet"/, 'and the anchor it points at has to exist');
  });
});

describe('what the page says about it', () => {
  const html = readFileSync(new URL('../../web/fraud.html', import.meta.url), 'utf8');

  test('the numbers in the prose are the numbers in the model', () => {
    const section = html.slice(html.indexOf('id="wallet"'), html.indexOf('id="wallet"') + 3000);
    assert.match(section, new RegExp(`\\$${CAP}\\b`),
      'the caption names a ceiling the model does not use');
    assert.match(section, /three days/i);
  });

  test('the honest caveat travels with it', () => {
    assert.match(html, /estimated_cost_micros/,
      'every ceiling here counts what callers declare, and the page has to keep saying so');
  });
});
