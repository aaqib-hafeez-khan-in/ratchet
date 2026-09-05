// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Three mobile regressions, pinned as rules rather than as pixels.
 *
 * A stylesheet test cannot measure a layout, so this does not try. What it does
 * is assert the specific properties whose absence caused each bug, because each
 * one was reintroduced by an ordinary, reasonable-looking edit:
 *
 *   The page scrolled sideways because a flex item wrapping a <pre> defaulted to
 *   min-width:auto and refused to be narrower than the code inside it. The pre
 *   scrolled perfectly well; nothing was ever going to notice that its wrapper
 *   did not.
 *
 *   It scrolled sideways again after a ninth link was added to a nav that only
 *   became a scroller below 640px — a media query that was really a guess about
 *   how many links fit, and the guess expired.
 *
 *   The pinned scroll animations were cut off because 100vh on a phone is the
 *   viewport WITHOUT browser chrome. A sticky element sized in vh is taller than
 *   what you can see, so its bottom never comes into view however far you scroll.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dirname, '../../web/assets/style.css'), 'utf8');

/** The declaration block for a selector, at the top level of the sheet. */
function topLevelRule(selector: string): string {
  // Strip every @media block first, so a rule that only exists inside one is
  // not mistaken for an unconditional one.
  let flat = '', depth = 0, inMedia = 0;
  for (let i = 0; i < css.length; i += 1) {
    if (css.startsWith('@media', i) && depth === 0) { inMedia = 1; }
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') { depth -= 1; if (inMedia && depth === 0) { inMedia = 0; continue; } }
    if (!inMedia) flat += css[i];
  }
  const at = flat.indexOf(selector + ' {');
  if (at < 0) return '';
  return flat.slice(at, flat.indexOf('}', at));
}

describe('the page must not scroll sideways', () => {
  test('the nav is a scroller at every width, not only on phones', () => {
    const rule = topLevelRule('nav.site');
    assert.match(rule, /overflow-x:\s*auto/,
      'a nav that only scrolls below a breakpoint overflows the moment a link is added');
    assert.match(rule, /min-width:\s*0/,
      'and it must be allowed to be narrower than its links inside the header flex row');
  });

  test('the code wrapper may be narrower than the code', () => {
    const rule = topLevelRule('.copywrap');
    assert.match(rule, /min-width:\s*0/,
      'the <pre> scrolls; its wrapper was what refused to shrink');
  });

  test('a canvas figure is bounded by its box, not by its backing store', () => {
    // A canvas has an intrinsic 300x150. Without an explicit width it lays out
    // at 300px and, worse, will not shrink below it inside a grid item — the
    // same min-width:auto blowout the rules above exist for. The wallet figure
    // sits in normal flow today, so this is a guard against it being moved into
    // a grid later and quietly widening the page on a phone.
    const rule = topLevelRule('.walletfig canvas');
    assert.match(rule, /width:\s*100%/,
      'the canvas must take its width from its container, not from its backing store');
    assert.match(rule, /display:\s*block/,
      'an inline canvas also picks up a baseline gap under it');
  });

  test('containers that can hold code or tables may shrink', () => {
    assert.match(css, /\.entry\s*>\s*\*\s*\{[^}]*min-width:\s*0/,
      'a grid item defaults to min-width:auto and will not go below its content');
  });
});

/**
 * A select that keeps the native appearance is drawn by the OS, which honours
 * background-color inconsistently and draws the option popup in system colours.
 * On a dark theme that can leave the control looking like the page behind it —
 * present, focusable, operable, and invisible. Reported from the console's API
 * keys form, where the surrounding inputs rendered and the dropdown did not.
 */
describe('a select is drawn by us, not by the operating system', () => {
  /**
   * topLevelRule('select') finds `input, select {` first — the substring is in
   * it — and that block is not the one under test. Anchor to a line start.
   */
  const selectRule = (() => {
    const m = /\nselect \{([\s\S]*?)\}/.exec(css);
    return m ? m[1]! : '';
  })();

  test('the native appearance is removed', () => {
    const rule = selectRule;
    assert.match(rule, /appearance:\s*none/,
      'with menulist appearance the browser may ignore our background entirely');
    assert.match(rule, /-webkit-appearance:\s*none/, 'Safari needs the prefix');
  });

  test('it does not sit on the same colour as the page', () => {
    const rule = selectRule;
    assert.match(rule, /background-color:\s*var\(--bg-sunk\)/,
      'var(--bg) is the page itself, so the control would read as empty space');
  });

  test('having taken the chevron away, we draw one', () => {
    const rule = selectRule;
    assert.match(rule, /background-image:\s*url\("data:image\/svg/,
      'appearance:none removes the arrow — without replacing it, nothing says '
      + 'this field opens');
    assert.match(rule, /padding-right/, 'and the text must not run under it');
  });

  test('the option popup is given colours too', () => {
    assert.match(css, /select option \{[^}]*background:[^}]*color:/,
      'the popup is an OS surface and falls back to system colours otherwise');
  });

  test('forced-colours users get their own control back', () => {
    assert.match(css, /@media \(forced-colors: active\)[\s\S]{0,200}appearance:\s*auto/,
      'overriding a high-contrast or forced-colour mode is how you break a '
      + 'control for the people who most need it drawn their way');
  });
});

/**
 * The API has always accepted daily_budget_micros when minting a key; the
 * console form only ever sent name and scopes. So the advice "give that key a
 * small daily budget" — correct advice, for a key you are handing to someone
 * else's infrastructure — described a field that did not exist.
 */
describe('a key can be given a budget where keys are made', () => {
  const js = readFileSync(new URL('../../web/assets/console.js', import.meta.url), 'utf8');

  test('the form has the field', () => {
    assert.match(js, /id="key-budget"/,
      'the ceiling is settable over the API and was not settable in the console');
  });

  test('it is sent, and empty means no ceiling rather than a ceiling of zero', () => {
    assert.match(js, /daily_budget_micros:/);
    assert.match(js, /\? null : Math\.round/,
      'a budget of zero would refuse every declared spend the key ever made');
  });

  test('the table shows which keys have one', () => {
    assert.match(js, /'Daily budget'/,
      'a key with no ceiling should be visibly a key with no ceiling');
    assert.match(js, /k\.dailyBudgetMicros/,
      '/v1/keys returns the domain object directly, so its wire shape is camelCase');
  });
});

describe('an in-page anchor must clear the sticky header', () => {
  /**
   * Found by following the pricing page's own "arranged directly" link on a
   * phone: the heading landed 32px behind the header. Every #anchor on the site
   * had the same problem — the footer's /docs#groups, the explainer's #how — it
   * had simply never been followed on a narrow screen and measured.
   */
  test('scroll-padding-top is set, and accounts for the header', () => {
    const rule = topLevelRule('html');
    assert.match(rule, /scroll-padding-top/,
      'without this a sticky header covers whatever an anchor scrolls to');
    assert.match(rule, /58px/,
      'the offset should be derived from the header height, not a guessed number');
  });

  test('the taller wrapped header on a phone gets a larger offset', () => {
    assert.match(css, /@media \(max-width: 640px\) \{ html \{ scroll-padding-top/,
      'the nav strip wraps to two rows below 640px, so the header is ~81px there');
  });

  test('the header height the offset assumes is the header height', () => {
    const header = topLevelRule('header.site .wrap');
    assert.match(header, /height:\s*58px/,
      'if the header height changes, the anchor offset has to change with it');
  });
});

describe('a pinned beat must fit the visible viewport', () => {
  const pin = topLevelRule('.stage-pin');

  test('it is sized in dvh, with vh only as the fallback', () => {
    assert.match(pin, /height:\s*calc\(100dvh/,
      '100vh on a phone excludes the browser chrome, so a vh-sized sticky pin '
      + 'is taller than the window and its bottom is unreachable');
    const vhAt = pin.indexOf('calc(100vh');
    const dvhAt = pin.indexOf('calc(100dvh');
    assert.ok(vhAt >= 0 && vhAt < dvhAt,
      'the vh line must come first, or it would override the dvh one');
  });

  test('the 600px minimum is lifted where the window is smaller than that', () => {
    assert.match(css, /@media\s*\(max-width:\s*44rem\),\s*\(max-height:\s*44rem\)/,
      'a short landscape phone needs the same treatment as a narrow portrait one');
    const short = css.slice(css.indexOf('@media (max-width: 44rem), (max-height: 44rem)'));
    assert.match(short.slice(0, 900), /\.stage-pin\s*\{\s*min-height:\s*0/,
      '600px of minimum inside a 560px window is the entire bug');
  });
});

/**
 * Two controls that were the right drawing and the wrong target.
 *
 * The progress rail under each pinned beat is a row of 34x4px bars — four
 * pixels is what reads as a rail, and four pixels is not something a thumb can
 * hit. WCAG 2.5.8 asks for 24. Nothing caught it because the bars are exactly
 * the size they were designed to be; the defect was that they were also the
 * whole target.
 *
 * The nav links measured 23.5px: half a pixel under the same floor, which no
 * amount of looking was ever going to reveal.
 */
describe('a control must be big enough to hit, whatever size it is drawn', () => {
  test('the rail bars carry a touch area larger than the bar', () => {
    const hit = topLevelRule('.rail button::after');
    assert.ok(hit, 'the rail bars must have a ::after hit area');
    assert.match(hit, /position:\s*absolute/, 'the hit area must not affect layout');
    const h = /height:\s*(\d+)px/.exec(hit);
    assert.ok(h, 'the hit area needs an explicit height');
    assert.ok(
      Number(h[1]) >= 24,
      `WCAG 2.5.8 asks for 24px; the hit area is ${h[1]}px`,
    );
    // The bar itself must stay small, or the fix has changed the design.
    assert.match(topLevelRule('.rail button'), /height:\s*4px/);
  });

  test('a nav link is at least 24px tall', () => {
    const rule = topLevelRule('nav.site a');
    const m = /min-height:\s*(\d+)px/.exec(rule);
    assert.ok(m, 'nav links need an explicit minimum height');
    assert.ok(Number(m[1]) >= 24, `nav links are ${m[1]}px; the floor is 24`);
    assert.match(rule, /align-items:\s*center/, 'the text must stay centred in it');
  });
});

/**
 * Figure labels have a floor, because a legend nobody can read is decoration.
 *
 * The axis captions, ledger totals, band scales and case tags drifted down to
 * 9px and 10px per component — small enough on a 375px phone to be a shape
 * rather than a word, and these are the labels carrying what the figure means:
 * "who it is going to", "ceiling $2,000", "Attempted".
 *
 * Expressed as a rule on the stylesheet rather than a measurement, for the same
 * reason as everything above it: the next 9px label will arrive in a `font:`
 * shorthand that looks exactly like its neighbours.
 */
describe('nothing is set smaller than a phone can read', () => {
  const FLOOR_REM = 0.6875; // 11px at a 16px root

  test('no font shorthand goes below the floor', () => {
    const offenders: string[] = [];
    for (const m of css.matchAll(/font:\s*[^;]*?(\d*\.?\d+)rem\s*\//g)) {
      const rem = Number(m[1]);
      if (rem < FLOOR_REM) {
        const at = css.slice(0, m.index).split('\n').length;
        offenders.push(`line ${at}: ${rem}rem`);
      }
    }
    assert.deepEqual(offenders, [],
      `below ${FLOOR_REM}rem (${FLOOR_REM * 16}px) — raise it, or the label is decoration`);
  });

  /**
   * One documented exception, not a silent one.
   *
   * .packet.tiny is a digit inside a fixed 26px token in the retry-swarm
   * figure — a glyph scaled to its container, not a label you read a sentence
   * of. It is already at the edge of that box at 0.66rem, so the floor would
   * push the digit out of its own circle. Anything else added here needs the
   * same kind of reason written next to it.
   */
  const EXEMPT = ['.packet.tiny'];

  test('no font-size declaration goes below it either', () => {
    const offenders: string[] = [];
    for (const m of css.matchAll(/font-size:\s*(\d*\.?\d+)rem/g)) {
      const rem = Number(m[1]);
      if (rem >= FLOOR_REM) continue;
      const lineStart = css.lastIndexOf('\n', m.index) + 1;
      const line = css.slice(lineStart, css.indexOf('\n', m.index));
      if (EXEMPT.some((sel) => line.includes(sel))) continue;
      offenders.push(`line ${css.slice(0, m.index).split('\n').length}: ${rem}rem`);
    }
    assert.deepEqual(offenders, [], `below ${FLOOR_REM}rem`);
  });

  test('every exemption still exists, so the list cannot rot', () => {
    for (const sel of EXEMPT) {
      assert.ok(css.includes(sel), `${sel} is exempt from the floor but no longer in the sheet`);
    }
  });

  test('the check is looking at real declarations', () => {
    // Guard against a regex that matches nothing and therefore always passes.
    const found = [...css.matchAll(/font:\s*[^;]*?(\d*\.?\d+)rem\s*\//g)];
    assert.ok(found.length > 8, `only ${found.length} font shorthands matched`);
  });
});
