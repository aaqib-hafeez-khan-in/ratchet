// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../../', import.meta.url);
const DIRECTORIES = ['src', 'test', 'scripts', 'web/assets'];
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.sh', '.sql']);
const SKIPPED_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist']);
const HEADERS = {
  '.ts': ['// SPDX-License-Identifier: Apache-2.0', '// Copyright 2026 Deimos LLC'],
  '.js': ['// SPDX-License-Identifier: Apache-2.0', '// Copyright 2026 Deimos LLC'],
  '.mjs': ['// SPDX-License-Identifier: Apache-2.0', '// Copyright 2026 Deimos LLC'],
  '.sh': ['# SPDX-License-Identifier: Apache-2.0', '# Copyright 2026 Deimos LLC'],
  '.sql': ['-- SPDX-License-Identifier: Apache-2.0', '-- Copyright 2026 Deimos LLC'],
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) {
      files.push(path);
    }
  }
  return files;
}

test('every source file has SPDX and copyright headers', () => {
  const missing: string[] = [];

  for (const directory of DIRECTORIES) {
    const path = new URL(`${directory}/`, ROOT).pathname;
    for (const file of sourceFiles(path)) {
      const extension = file.slice(file.lastIndexOf('.')) as keyof typeof HEADERS;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      const headers = HEADERS[extension];
      const offset = lines[0]?.startsWith('#!') ? 1 : 0;
      if (lines[offset] !== headers[0] || lines[offset + 1] !== headers[1]) {
        missing.push(file.replace(`${ROOT.pathname}`, ''));
      }
    }
  }

  assert.deepEqual(missing, [], `Missing SPDX/copyright header: ${missing.join(', ')}`);
});

/**
 * A NUL byte in a source file is not a style question. `git diff` reports the
 * file as `Bin 8333 -> 8339 bytes` with no line-level diff, so a change to it
 * cannot be reviewed; and plain `grep` skips the file entirely and exits 1, so
 * every grep-based check in this repository silently passes on it.
 *
 * `src/domain/vendor-keys.ts` carried one for several releases as the separator
 * in the vendor idempotency key material. Write it as an escape.
 */
test('no source file contains a raw NUL byte', () => {
  const offenders: string[] = [];

  for (const directory of DIRECTORIES) {
    const path = new URL(`${directory}/`, ROOT).pathname;
    for (const file of sourceFiles(path)) {
      if (readFileSync(file).includes(0)) offenders.push(file.replace(`${ROOT.pathname}`, ''));
    }
  }

  assert.deepEqual(offenders, [],
    `Raw NUL byte, so git cannot diff it and grep cannot see it: ${offenders.join(', ')}`);
});
