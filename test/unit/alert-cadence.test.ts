// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The alert channel must not spend the mail budget it shares with customers.
 *
 * On 2 Sep 2026 the probe mailed on every failing check, fifteen minutes apart.
 * A sustained outage is 96 emails a day, which is the entire free sending quota
 * — and the mail it crowded out was signup verification links.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** Mirrors scripts/alert.mjs. The subprocess tests below pin them together. */
const shouldNotify = (streak: number) =>
  streak <= 3 ? true : streak <= 24 ? streak % 4 === 0 : streak % 16 === 0;

const run = (streak: number) => execFileSync(
  process.execPath, ['scripts/alert.mjs', 'down', 'test summary'],
  { env: { ...process.env, FAIL_STREAK: String(streak),
           ALERT_EMAIL: '', ALERT_EMAIL_KEY: '' }, encoding: 'utf8' });

describe('repeat outage notices thin out', () => {
  test('the first three checks always send — 45 minutes of silence is too long', () => {
    for (const s of [1, 2, 3]) assert.equal(shouldNotify(s), true, `streak ${s}`);
  });

  test('a day-long outage costs a handful of emails, not the whole quota', () => {
    const sent = Array.from({ length: 96 }, (_, i) => i + 1).filter(shouldNotify);
    assert.ok(sent.length <= 20, `${sent.length} emails in a day is still a storm`);
    assert.ok(sent.length >= 8, `${sent.length} is too quiet to notice an outage`);
  });

  test('it never goes fully silent — an outage keeps reporting itself', () => {
    // Any four-hour stretch of a long outage still produces a notice.
    for (let start = 25; start < 200; start += 16) {
      const window = Array.from({ length: 16 }, (_, i) => start + i);
      assert.ok(window.some(shouldNotify), `silent from streak ${start}`);
    }
  });

  test('the script itself agrees — suppressed', () => {
    const out = run(5);
    assert.match(out, /suppressed a repeat notice/);
  });

  test('the script itself agrees — sent', () => {
    // With no channel configured it stops at the configuration notice, which is
    // reached only by getting PAST the suppression check.
    const out = run(2);
    assert.match(out, /No ALERT_EMAIL/);
    assert.equal(out.includes('suppressed'), false);
  });
});
