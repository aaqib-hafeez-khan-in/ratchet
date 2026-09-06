// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * GET /v1/coverage over real HTTP.
 *
 * The property under test is not the arithmetic — that is covered in
 * test/integration/coverage.test.ts. It is that the endpoint refuses anonymous
 * callers, that it appears in the published contract, and above all that a type
 * with no comparison is reported as unknown rather than as complete. A coverage
 * figure that flatters an unmeasured system is worse than no figure.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, closePool, setPlan } from '../helpers.js';

const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let apiKey: string;

before(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.ready();
  const ws = await createWorkspace('Coverage Co', 'coverage@example.test');
  apiKey = ws.key.plaintext;
  // Coverage sits behind the same `reconciliation` capability as POST /v1/reconcile,
  // deliberately: it reports reconciliation evidence and gating it differently
  // would make the plan boundary incoherent.
  await setPlan(ws.workspaceId, 'scale');
});
after(async () => { await app.close(); await closePool(); });

const get = (url: string, key?: string) => app.inject({
  method: 'GET', url, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
});

describe('GET /v1/coverage', () => {
  test('refuses a caller with no credential', async () => {
    const res = await get('/v1/coverage');
    assert.equal(res.statusCode, 401);
  });

  test('an operator key can read it', async () => {
    const res = await get('/v1/coverage', apiKey);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.effect_types));
    assert.equal(typeof body.unknown_types, 'number');
  });

  /**
   * `createWorkspace` seeds policies for email.send and payment.charge only, so
   * those two are the only types a new workspace will ever be reminded about.
   * Every other type a customer actually runs — this one — had no row, and so
   * appeared in no report at all until coverage read from traffic instead.
   */
  test('a gated type that was never compared reports unknown, not complete', async () => {
    await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: {
        effect_type: 'slack.post', idempotency_key: 'cov-1', payload: { channel: 'C1' },
      },
    });

    const body = (await get('/v1/coverage', apiKey)).json();
    const row = body.effect_types.find((r: { effect_type: string }) => r.effect_type === 'slack.post');

    assert.ok(row, 'a type carrying traffic must be listed even with no policy row');
    assert.equal(row.coverage, null, 'never compared must not render as 100%');
    assert.equal(row.status, 'unknown');
    assert.equal(row.configured, false);
    assert.ok(body.unknown_types >= 1);
  });

  test('it is in the published contract, so the docs cannot drift from it', async () => {
    const spec = (await get('/openapi.json')).json();
    assert.ok(spec.paths['/v1/coverage']?.get, '/v1/coverage missing from the OpenAPI document');
    assert.equal(spec.paths['/v1/coverage'].get.operationId, 'coverage');
  });
});
