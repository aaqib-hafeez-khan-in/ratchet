// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A reproducible build needs a toolchain that does not move under it.
 *
 * `scripts/verify-reproducible.sh` proves two clean builds are identical right
 * now. It cannot prove they will still match next month, because that depends
 * on getting the same compiler and the same base image — and a caret on the
 * TypeScript version is enough to silently end that, with nothing failing until
 * somebody compares two builds and finds they differ.
 *
 * So the property under test is not the output. It is that nothing in the
 * toolchain is free to float.
 */

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  devDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
};
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

describe('the build toolchain cannot drift', () => {
  test('TypeScript is pinned to an exact version', () => {
    const v = pkg.devDependencies.typescript;
    assert.ok(v, 'typescript must be a devDependency');
    assert.match(v, /^\d+\.\d+\.\d+$/,
      `typescript is "${v}"; a range means two builds can use different compilers`);
  });

  test('every base image is pinned by digest, not by tag', () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
    assert.ok(froms.length > 0, 'the Dockerfile must have a FROM');
    for (const image of froms) {
      if (image === 'scratch' || !image.includes('/') && !image.includes(':')) continue;
      assert.match(image, /@sha256:[0-9a-f]{64}$/,
        `${image} is pinned by tag; a tag can be repointed at different bytes`);
    }
  });

  test('the lockfile is committed, so dependencies resolve identically', () => {
    const lock = JSON.parse(
      readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
    ) as { lockfileVersion: number };
    assert.ok(lock.lockfileVersion >= 2,
      'lockfileVersion must be 2+ so resolved integrity hashes are recorded');
  });

  test('the check itself exists and is wired to a command', () => {
    const scripts = (JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }).scripts;
    assert.ok(scripts['verify:build'], 'npm run verify:build must exist');
    assert.match(scripts['verify:build']!, /verify-reproducible/);
  });
});
