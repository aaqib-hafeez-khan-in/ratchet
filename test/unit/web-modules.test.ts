// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Every browser module must actually parse.
 *
 * `web/assets/pricing.js` shipped with an unterminated template literal. The
 * arrow function that renders the capability list opened a template and never
 * closed it, so sixteen lines of plan-card markup were swallowed into the
 * string and the file failed to parse — which meant the pricing page rendered
 * "Loading plans…" and nothing else, in production, for anyone deciding whether
 * to pay. Even the catch block that exists to show a fallback was in the file
 * that could not load.
 *
 * Nothing was checking these. TypeScript does not see them, the test suite ran
 * them past nobody, and the failure is silent: the page looks like it is still
 * working on it. So now every module in web/assets is parsed on every run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ASSETS = join(import.meta.dirname, '../../web/assets');
const modules = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));

describe('browser modules', () => {
  test('there are some to check', () => {
    assert.ok(modules.length >= 5, `only found ${modules.length} in web/assets`);
  });

  for (const file of modules) {
    test(`${file} parses`, () => {
      // Copied to .mjs so node parses it as a module rather than guessing: these
      // are served as modules and must be checked the way they are run.
      const dir = mkdtempSync(join(tmpdir(), 'webmod-'));
      const copy = join(dir, file.replace(/\.js$/, '.mjs'));
      writeFileSync(copy, readFileSync(join(ASSETS, file)));
      try {
        execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
      } catch (err) {
        const detail = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
        assert.fail(`${file} does not parse:\n${detail.split('\n').slice(0, 6).join('\n')}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
