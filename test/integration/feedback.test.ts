// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * The second unauthenticated write in the service.
 *
 * `begin` is the first, and it is safe because it can only ever provision a new
 * workspace. This one stores free text a stranger typed, which is a different
 * shape of risk: the danger is not that it grants something, it is that it
 * becomes a spam pipe or a way to write into our own dashboard.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPool } from '../../src/db/pool.js';
import { record, summary, messages, gcWindows, GLOBAL_PER_MINUTE }
  from '../../src/domain/feedback.js';
import { closePool } from '../helpers.js';

after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM page_feedback');
  await getPool().query('DELETE FROM page_feedback_windows');
});

describe('what may be stored', () => {
  test('a plain vote is recorded and counted', async () => {
    await record({ path: '/pricing', wasClear: false });
    await record({ path: '/pricing', wasClear: true });
    await record({ path: '/pricing', wasClear: true });

    const [row] = await summary();
    assert.equal(row?.path, '/pricing');
    assert.equal(row?.unclear, 1);
    assert.equal(row?.clear, 2);
  });

  test('the worst page sorts first, which is the whole point', async () => {
    await record({ path: '/docs', wasClear: false });
    for (let i = 0; i < 4; i++) await record({ path: '/pricing', wasClear: false });

    const rows = await summary();
    assert.equal(rows[0]?.path, '/pricing');
    assert.equal(rows[0]?.unclear, 4);
  });

  // A stranger choosing the path would be choosing what appears in our own
  // report. Everything that is not a path this site could serve is dropped.
  test('a path we do not serve is refused', async () => {
    for (const path of [
      '/../etc/passwd',
      'https://evil.example/x',
      '/<script>alert(1)</script>',
      '/PRICING',
      '/a?b=c',
      `/${'x'.repeat(200)}`,
    ]) {
      const r = await record({ path, wasClear: false });
      assert.equal(r.stored, false, `${path} should not be stored`);
    }
    assert.deepEqual(await summary(), []);
  });

  test('control characters are stripped, newlines kept', async () => {
    await record({
      path: '/faq',
      wasClear: false,
      // A reader describing a layout bug legitimately pastes two lines.
      message: 'line one\nline two\u0007  with a bell and a null\u0000',
    });
    const [m] = await messages();
    assert.ok(m);
    assert.match(m.message, /line one\nline two/, 'the shape of what they wrote survives');
    assert.doesNotMatch(m.message, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/,
      'control characters do not');
  });

  test('an over-long message is truncated rather than refused', async () => {
    await record({ path: '/docs', wasClear: false, message: 'z'.repeat(9000) });
    const [m] = await messages();
    assert.ok(m && m.message.length <= 2000);
  });

  test('an empty message stores as no message, not as an empty one', async () => {
    await record({ path: '/docs', wasClear: false, message: '   ' });
    assert.deepEqual(await messages(), [],
      'whitespace is not a message and should not appear in the digest');
    const [row] = await summary();
    assert.equal(row?.unclear, 1, 'but the vote still counts');
  });
});

describe('it cannot be turned into a spam pipe', () => {
  // The route's own rate limit is per-IP and therefore evadable. This ceiling
  // is not, because it is a single row in the database.
  test('a global per-minute ceiling holds regardless of source', async () => {
    const attempts = GLOBAL_PER_MINUTE + 25;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => record({ path: '/faq', wasClear: false })));

    const stored = results.filter((r) => r.stored).length;
    assert.equal(stored, GLOBAL_PER_MINUTE,
      `expected exactly ${GLOBAL_PER_MINUTE} stored, got ${stored}`);

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM page_feedback');
    assert.equal(Number(rows[0]?.n), GLOBAL_PER_MINUTE,
      'the database must agree with what the caller was told');
  });

  test('spent windows are collected rather than accumulating forever', async () => {
    await getPool().query(
      "INSERT INTO page_feedback_windows (minute_start, count) VALUES (now() - interval '3 hours', 5)");
    await record({ path: '/faq', wasClear: true });

    assert.equal(await gcWindows(), 1, 'the old window goes');
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM page_feedback_windows');
    assert.equal(Number(rows[0]?.n), 1, 'the current one stays');
  });
});
