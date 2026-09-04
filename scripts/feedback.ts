// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * What readers said, worst page first.
 *
 * There is no HTTP read for this. Site feedback belongs to no workspace, so
 * every credential the API has is the wrong shape for it, and inventing an
 * admin one to read a list of complaints is not a trade worth making. This
 * talks to the database directly, which the operator already has.
 *
 *   npm run feedback
 */
import { summary, messages } from '../src/domain/feedback.js';
import { closePool } from '../src/db/pool.js';

const bar = (unclear: number, clear: number) => {
  const total = unclear + clear;
  if (!total) return '';
  const width = 24;
  const bad = Math.round((unclear / total) * width);
  return '#'.repeat(bad) + '.'.repeat(width - bad);
};

const main = async () => {
  const pages = await summary();
  if (!pages.length) {
    console.log('No feedback yet.');
    return;
  }

  console.log('\nPages, most-confusing first');
  console.log('='.repeat(72));
  console.log(`${'path'.padEnd(34)} ${'unclear'.padStart(7)} ${'clear'.padStart(5)}  ratio`);
  for (const p of pages) {
    console.log(`${p.path.padEnd(34)} ${String(p.unclear).padStart(7)} `
      + `${String(p.clear).padStart(5)}  ${bar(p.unclear, p.clear)}`);
  }

  const notes = await messages();
  if (notes.length) {
    console.log(`\nWhat they wrote (${notes.length})`);
    console.log('='.repeat(72));
    for (const m of notes) {
      console.log(`\n${m.createdAt}  ${m.path}  `
        + `${m.wasClear ? 'clear' : 'UNCLEAR'}${m.viewport ? `  ${m.viewport}` : ''}`);
      // Indented so a multi-line message cannot be mistaken for our own output.
      for (const line of m.message.split('\n')) console.log(`    ${line}`);
      if (m.replyTo) console.log(`    -- reply to: ${m.replyTo}`);
    }
  }
  console.log();
};

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => closePool());
