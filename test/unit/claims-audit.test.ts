// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Numbers we publish, checked against the numbers that are true.
 *
 * CLAUDE.md §11 says a change is not done if it has made a claim untrue. Nothing
 * enforced that for *figures*, and on 5 Sep 2026 it showed: two documents said
 * "no coverage tool is configured, so no coverage percentage is claimed
 * anywhere" while the OpenSSF badge claimed 90.87% statement coverage. Both were
 * public, they contradicted each other, and a reader had no way to know which
 * the project stood behind. Three other documents carried test counts stale by
 * hundreds.
 *
 * The rule this encodes: a number in a living document is a claim, and a claim
 * has to be checkable. Where a figure moves faster than anyone will remember to
 * edit it, the document must state a floor ("over 1000 tests") rather than a
 * reading ("1102 tests"), because a floor stays true as the number grows and a
 * reading is wrong the next morning.
 *
 * DATED DOCUMENTS ARE EXCLUDED, deliberately. An incident report from 31 August
 * saying there were 12 vendors is not stale, it is a record of 31 August.
 * Rewriting history to satisfy a linter would destroy the thing those files are
 * for. Only documents that describe the present are held to the present.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_PROFILES } from '../../src/domain/vendor-keys.js';

const ROOT = new URL('../../', import.meta.url).pathname;

/** A snapshot of a past date is not a claim about today. */
const IS_DATED_RECORD = /_\d{4}-\d{2}-\d{2}/;

function livingDocuments(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!entry.endsWith('.md')) continue;
      if (IS_DATED_RECORD.test(entry)) continue;
      out.push(path);
    }
  };
  walk(join(ROOT, 'docs'));
  out.push(join(ROOT, 'README.md'), join(ROOT, 'CLAUDE.md'));
  return out;
}

const rel = (p: string) => p.replace(ROOT, '');

/**
 * Only the two documents that describe the floors are held to them. Elsewhere a
 * percentage is usually a measurement, and a measurement is not a threshold.
 */
const FLOOR_DOCS = ['CLAUDE.md', 'docs/SSDF.md'];

test('published coverage floors match the floors CI actually enforces', () => {
  // The floor is what stops a published percentage quietly becoming false, so a
  // document describing a floor that CI does not enforce is worse than silence.
  const harness = readFileSync(join(ROOT, 'scripts/test.sh'), 'utf8');
  const configured: Record<string, number> = {};
  for (const metric of ['statements', 'branches', 'lines', 'functions']) {
    const m = harness.match(new RegExp(`--${metric}\\s+(\\d+)`));
    assert.ok(m, `scripts/test.sh no longer sets a --${metric} threshold`);
    configured[metric] = Number(m![1]);
  }

  const wrong: string[] = [];
  for (const doc of FLOOR_DOCS.map((d) => join(ROOT, d))) {
    const text = readFileSync(doc, 'utf8');
    // The lookbehind keeps "91.1%" from reading as "1%", which is exactly the
    // false positive the first draft of this test produced.
    for (const [, pct, metric] of text.matchAll(/(?<![\d.])(\d+)%\s+(statements|branches|lines|functions)/g)) {
      if (Number(pct) !== configured[metric!]) {
        wrong.push(`${rel(doc)}: claims ${pct}% ${metric}, CI enforces ${configured[metric!]}%`);
      }
    }
  }
  assert.deepEqual(wrong, [], `Coverage floor claims out of step with scripts/test.sh:\n${wrong.join('\n')}`);
});

test('test counts are either anchored to a file or written as a floor', () => {
  // Two kinds of claim, and only one of them goes stale.
  //
  //   "11 tests, `test/integration/crypto.test.ts`"  — anchored. Verifiable, and
  //       useful: it tells a reader exactly where to look. Checked below.
  //   "442 tests"                                     — a global reading with no
  //       anchor. It was true in week one and is now wrong by 660.
  //
  // Static declarations undercount the runtime total (parameterised tests), so
  // this is a genuine lower bound: a floor at or beneath it cannot go false.
  const declared = countTestDeclarations(join(ROOT, 'test'));
  const offenders: string[] = [];

  for (const doc of livingDocuments()) {
    for (const line of readFileSync(doc, 'utf8').split('\n')) {
      for (const m of line.matchAll(/(\w+\s+)?(\d[\d,]*)\s+tests\b/g)) {
        const preceding = (m[1] ?? '').trim().toLowerCase();
        const claimed = Number(m[2]!.replace(/,/g, ''));
        const anchor = line.match(/(test\/[\w./-]+\.test\.ts)/);

        if (anchor) {
          const actual = countTestDeclarations(join(ROOT, anchor[1]!));
          if (actual < claimed) {
            offenders.push(`${rel(doc)}: claims ${claimed} tests in ${anchor[1]}, which declares ${actual}`);
          }
          continue;
        }
        if (['over', 'than', 'least', 'above', 'exceeds'].includes(preceding)) {
          if (claimed > declared) {
            offenders.push(`${rel(doc)}: floor of ${claimed} tests exceeds the ${declared} declared`);
          }
          continue;
        }
        offenders.push(
          `${rel(doc)}: "${m[2]} tests" is an unanchored reading — name the test file, or write "over N tests"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Test-count claims that will go stale:\n${offenders.join('\n')}`);
});

test('vendor counts in living documents match the profiles that exist', () => {
  const actual = Object.keys(VENDOR_PROFILES).length;
  const wrong: string[] = [];
  for (const doc of livingDocuments()) {
    const text = readFileSync(doc, 'utf8');
    for (const m of text.matchAll(/(\d+)\s+vendor(?:s| profiles)\b/g)) {
      if (Number(m[1]) !== actual) {
        wrong.push(`${rel(doc)}: claims ${m[1]} vendors, ${actual} profiles exist`);
      }
    }
  }
  assert.deepEqual(wrong, [], `Vendor counts out of step with VENDOR_PROFILES:\n${wrong.join('\n')}`);
});

/** Counts declarations in a file, or recursively in a directory. */
function countTestDeclarations(path: string): number {
  if (!statSync(path).isDirectory()) {
    if (!path.endsWith('.ts')) return 0;
    return (readFileSync(path, 'utf8').match(/^\s*(?:test|it)\(/gm) ?? []).length;
  }
  let n = 0;
  for (const entry of readdirSync(path)) n += countTestDeclarations(join(path, entry));
  return n;
}
