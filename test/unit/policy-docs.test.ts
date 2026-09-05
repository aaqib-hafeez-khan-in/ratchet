// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The policy reference table on /docs is a contract surface, and it drifted.
 *
 * `PUT /v1/policies/{effectType}` grew four fields — `required_dimensions`,
 * `dimension_limits`, `structuring_threshold_micros` and
 * `surge_cooldown_seconds` — and the table that claims to list the policy
 * fields never grew with them. Each one was documented somewhere else on the
 * site, which is exactly why nobody noticed: the page a reader actually
 * consults to learn what a policy accepts quietly described a smaller API than
 * the one that exists.
 *
 * So the table is now checked against the emitted OpenAPI document, in both
 * directions. A field added to the route schema has to be explained on the
 * page, and the page cannot name a field the server would reject.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../src/api/app.js';

const PATH = '/v1/policies/{effectType}';

let fields: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  // The live document, not a checked-in copy: `npm run openapi` writes the same
  // object to disk, so checking the source of that file cannot go stale.
  app = await buildApp({ logger: false });
  await app.ready();
  const spec = app.swagger() as {
    paths: Record<string, {
      put?: { requestBody?: { content: Record<string, { schema: { properties?: object } }> } };
    }>;
  };
  const body = spec.paths[PATH]?.put?.requestBody?.content['application/json']?.schema;
  assert.ok(body?.properties, `no PUT body schema for ${PATH} in the OpenAPI document`);
  fields = Object.keys(body.properties);
});

after(async () => { await app.close(); });

/**
 * The first column of the policy reference table. Found by the row that must be
 * there rather than by position, so reordering the sections does not silently
 * start checking a different table.
 */
function documentedFields(): string[] {
  const html = readFileSync(new URL('../../web/docs.html', import.meta.url), 'utf8');
  const tables = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((m) => m[1]!);
  const table = tables.find((t) => t.includes('>on_indeterminate<'));
  assert.ok(table, 'the policy reference table is gone from web/docs.html');
  return [...table.matchAll(/<tr><td class="mono">([a-z_]+)<\/td>/g)].map((m) => m[1]!);
}

describe('the policy reference table matches the API', () => {
  test('the PUT body has fields to check', () => {
    assert.ok(fields.length >= 10, `only found ${fields.length} policy fields`);
  });

  test('every field the API accepts is in the table', () => {
    const documented = new Set(documentedFields());
    const missing = fields.filter((f) => !documented.has(f));
    assert.deepEqual(missing, [],
      'PUT /v1/policies/{effectType} accepts these, and the reference table on /docs does not '
      + 'mention them — a reader consulting it gets an incomplete contract. Add a row.');
  });

  test('the table names no field the API would reject', () => {
    const real = new Set(fields);
    const invented = documentedFields().filter((f) => !real.has(f));
    assert.deepEqual(invented, [],
      'the table documents these, but the route schema rejects unknown properties, so a reader '
      + 'following it gets a 400');
  });
});
