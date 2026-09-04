import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Text has to be readable, and "it looks fine to me" is not a measurement.
 *
 * Every text token was legible enough to pass review by eye and three of them
 * still sat under the WCAG AA floor — --text-faint was at 3.12:1 against the
 * sunk background, carrying twelve eyebrow labels on the landing page alone.
 * Nothing caught it because nothing was looking.
 *
 * This computes the real relative-luminance ratio for every text token against
 * every surface token it can land on, in both themes, straight from the
 * stylesheet the site actually serves.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../../web/assets/style.css', import.meta.url)),
  'utf8',
);

/** WCAG 2.1 SC 1.4.3, normal text. */
const AA = 4.5;

const TEXT = ['--text', '--text-dim', '--text-faint'] as const;
const SURFACE = ['--bg', '--bg-sunk', '--bg-raised'] as const;

/**
 * The light palette is the bare :root; the dark one is the block inside the
 * prefers-color-scheme media query. Read them as whole blocks so a token
 * defined in one theme is never silently compared against the other's surface.
 */
function palette(theme: 'light' | 'dark'): Map<string, string> {
  const blocks = [...CSS.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
  const dark = CSS.indexOf('prefers-color-scheme: dark');
  assert.ok(dark > -1, 'the dark palette must exist');
  const wanted =
    theme === 'light'
      ? blocks.find((b) => CSS.indexOf(b) < dark)
      : blocks.find((b) => CSS.indexOf(b) > dark);
  assert.ok(wanted, `no ${theme} :root block`);

  const out = new Map<string, string>();
  for (const [, name, value] of wanted.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    if (name && value) out.set(name, value);
  }
  return out;
}

function channel(eight: number): number {
  const c = eight / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('every text token clears WCAG AA on every surface it can sit on', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}`, () => {
      const p = palette(theme);
      const failures: string[] = [];

      for (const t of TEXT) {
        const fg = p.get(t);
        assert.ok(fg, `${theme} is missing ${t}`);
        for (const s of SURFACE) {
          const bg = p.get(s);
          assert.ok(bg, `${theme} is missing ${s}`);
          const r = ratio(fg, bg);
          if (r < AA) failures.push(`${t} on ${s}: ${r.toFixed(2)}:1`);
        }
      }

      assert.deepEqual(
        failures,
        [],
        `below ${AA}:1 in the ${theme} palette — darken the token, do not shrink the type`,
      );
    });
  }

  test('the check can actually fail', () => {
    // A guard against the ratio maths quietly returning something that always
    // passes: this pair is unreadable and must be reported as such.
    assert.ok(ratio('#868d99', '#f6f7f9') < AA);
    assert.ok(ratio('#000000', '#ffffff') > AA);
  });
});

/**
 * Tokens passing is not the same as the page passing.
 *
 * Both benchmark bars drew their label with a colour that was chosen for the
 * other theme: a hardcoded #fff that works on the light-mode accent and gives
 * 2.69:1 on the dark one, and a dark-mode override painting the label in --bg
 * on a mid-grey bar for 1.88:1. Every token involved was fine on its own.
 * These are the specific foreground/background pairs the components actually
 * put on screen.
 */
describe('component colour pairs clear AA in both themes', () => {
  const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    ['gate bar label', '--accent-ink', '--accent'],
    ['quiet bar label', '--text', '--border-strong'],
    ['credential note', '--text-dim', '--bg-raised'],
    ['credential issuer', '--text-dim', '--bg-raised'],
  ];

  for (const theme of ['light', 'dark'] as const) {
    test(theme, () => {
      const p = palette(theme);
      const failures: string[] = [];
      for (const [what, fg, bg] of PAIRS) {
        const f = p.get(fg);
        const b = p.get(bg);
        assert.ok(f && b, `${theme} is missing ${fg} or ${bg}`);
        const r = ratio(f, b);
        if (r < AA) failures.push(`${what} (${fg} on ${bg}): ${r.toFixed(2)}:1`);
      }
      assert.deepEqual(failures, [], `below ${AA}:1 in the ${theme} palette`);
    });
  }

  test('no component paints text in a raw hex instead of a token', () => {
    // #fff on .bar-fill span was exactly this bug: invisible to a token audit
    // because it never was a token.
    const bar = /\.bar-fill span \{([^}]*)\}/.exec(CSS);
    assert.ok(bar, '.bar-fill span must exist');
    assert.doesNotMatch(
      bar[1] ?? '',
      /color:\s*#/,
      'use a token, so the colour follows the theme it is drawn on',
    );
  });
});
