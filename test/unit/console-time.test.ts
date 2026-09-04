import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Relative times have to point the right way.
 *
 * `when()` was written for created_at and updated_at, so it subtracted and
 * appended "ago". Then it was reused for a crypto quote's expiry — the one
 * timestamp in the console that is deliberately in the future — and rendered
 * "Quote expires -900s ago" on a quote issued two seconds earlier, next to an
 * address somebody was about to send money to.
 *
 * The helper lives in a browser module, so it is lifted out by source rather
 * than imported: that keeps the test honest about which code actually ships.
 */
const SRC = readFileSync(
  new URL('../../web/assets/console.js', import.meta.url),
  'utf8',
);

function loadWhen(): (iso: string | null) => string {
  const m = /const when = \(iso\) => \{[\s\S]*?\n\};/.exec(SRC);
  assert.ok(m, 'when() must exist in console.js');
  return new Function(`${m[0]}; return when;`)() as (iso: string | null) => string;
}

describe('a relative time points the way the timestamp does', () => {
  const when = loadWhen();
  const at = (secondsFromNow: number) =>
    new Date(Date.now() + secondsFromNow * 1000).toISOString();

  test('the past reads as elapsed', () => {
    assert.match(when(at(-30)), /^\d+s ago$/);
    assert.match(when(at(-600)), /^\d+m ago$/);
    assert.match(when(at(-7200)), /^\d+h ago$/);
  });

  test('the future reads as remaining, never as a negative elapsed time', () => {
    for (const secs of [30, 600, 7200]) {
      const out = when(at(secs));
      assert.doesNotMatch(out, /-/, `${secs}s ahead rendered as "${out}"`);
      assert.doesNotMatch(out, /ago/, `${secs}s ahead rendered as "${out}"`);
      assert.match(out, /^in \d+[smh]$/, `${secs}s ahead rendered as "${out}"`);
    }
  });

  test('a missing timestamp is a dash, not an Invalid Date', () => {
    assert.equal(when(null), '—');
    assert.equal(when(''), '—');
  });

  test('the quote expiry is the caller that needs the future case', () => {
    assert.match(SRC, /Quote expires \$\{when\(i\.expires_at\)\}/,
      'if this moved, check the new caller still reads forwards');
  });
});
