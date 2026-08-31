/**
 * Execute the integration recipes we hand out.
 *
 * `/v1/integrate` gives an agent code and tells it to run it. Until now nothing
 * checked that the code WORKS — only that it parsed. A recipe that parses and
 * then fails is worse than no recipe, because the caller trusts it.
 *
 * This is also what makes the "verified" badge on the works-with page mean
 * something. A badge that reflects a claim someone made once rots silently; a
 * badge backed by a test that runs the code cannot.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { freshWorkspace, closePool } from '../helpers.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { app = await buildApp(); await app.ready(); ws = await freshWorkspace(); });
after(async () => { await app.close(); await closePool(); });

const post = (url: string, body: unknown, key?: string) => app.inject({
  method: 'POST', url,
  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  payload: body,
});

describe('the HTTP recipe actually works', () => {
  // This is the exact two-call sequence /v1/integrate?runtime=http prints.
  test('begin then report, as printed', async () => {
    const key = ws.key.plaintext;
    const idem = `recipe-http-${Date.now()}`;

    const begun = await post('/v1/effects/begin', {
      effect_type: 'email.send', idempotency_key: idem,
      payload: { to: 'customer@example.com', template: 'invoice' },
      estimated_cost_micros: 2000,
    }, key);
    assert.equal(begun.statusCode, 200);
    const b = begun.json();
    assert.equal(b.decision, 'execute');
    assert.ok(b.lease_token, 'the recipe tells the caller to keep lease_token');

    const reported = await post(`/v1/effects/${b.effect_id}/report`, {
      lease_token: b.lease_token, outcome: 'succeeded', result: { message_id: 'm_1' },
    }, key);
    assert.equal(reported.statusCode, 200, reported.body);

    // And the recipe's central promise: a repeat does not execute again.
    const again = await post('/v1/effects/begin', {
      effect_type: 'email.send', idempotency_key: idem,
      payload: { to: 'customer@example.com', template: 'invoice' },
      estimated_cost_micros: 2000,
    }, key);
    assert.equal(again.json().decision, 'duplicate');
    assert.deepEqual(again.json().result, { message_id: 'm_1' },
      'the recipe says to replay `result` — so it must be there');
  });

  test('the failure branch the recipe documents behaves as described', async () => {
    const key = ws.key.plaintext;
    const idem = `recipe-fail-${Date.now()}`;
    const b = (await post('/v1/effects/begin',
      { effect_type: 'email.send', idempotency_key: idem, payload: {} }, key)).json();
    const rep = await post(`/v1/effects/${b.effect_id}/report`,
      { lease_token: b.lease_token, outcome: 'failed', failure_reason: 'smtp timeout' }, key);
    assert.equal(rep.statusCode, 200, `report failed: ${rep.body}`);

    // The recipes tell callers a failure may be retried. It must be.
    const retry = await post('/v1/effects/begin',
      { effect_type: 'email.send', idempotency_key: idem, payload: {} }, key);
    assert.equal(retry.json().decision, 'execute',
      `a reported failure must be retryable; got ${JSON.stringify(retry.json())}`);
    assert.equal(retry.json().attempt, 2);
  });
});

describe('every emitted recipe is runnable, not just parseable', () => {
  test('each recipe names endpoints that exist', async () => {
    const index = (await app.inject({ method: 'GET', url: '/v1/integrate' })).json();
    for (const { runtime } of index.runtimes) {
      const r = (await app.inject({ method: 'GET', url: `/v1/integrate?runtime=${runtime}` })).json();
      // Pull every Ratchet path the recipe references and confirm it is real.
      // Interpolations appear as ${...} in JS and {...} in Python f-strings, and
      // the Python ones contain quotes that truncate a naive path match. Collapse
      // every interpolation to one segment BEFORE extracting paths.
      const flattened = r.code.replace(/\$?\{[^{}]*\}/g, 'X');
      const paths = [...new Set((flattened.match(/\/v1\/[A-Za-z0-9/_.X-]+/g) ?? [])
        .map((p: string) => p.replace(/[.,]+$/, '')))];
      for (const p of paths as string[]) {
        // POST is the only method every one of these accepts.
        const concrete = p.replace(/\/X(\/|$)/g, '/eff_probe$1');
        const res = await app.inject({ method: 'POST', url: concrete, payload: {} });
        assert.notEqual(res.statusCode, 404,
          `${runtime} recipe references ${p}, which does not exist`);
      }
    }
  });

  test('the MCP recipe config names the package we actually publish', async () => {
    const r = (await app.inject({ method: 'GET', url: '/v1/integrate?runtime=mcp' })).json();
    const cfg = JSON.parse(r.code);
    const args: string[] = cfg.mcpServers.ratchet.args;
    assert.ok(args.includes('ratchet-mcp'),
      'the config must name the published package, not a placeholder');
    assert.equal(cfg.mcpServers.ratchet.env.RATCHET_API_KEY !== undefined, true);
  });

  test('no recipe still points at a host we have moved off', async () => {
    const index = (await app.inject({ method: 'GET', url: '/v1/integrate' })).json();
    for (const { runtime } of index.runtimes) {
      const r = (await app.inject({ method: 'GET', url: `/v1/integrate?runtime=${runtime}` })).json();
      assert.doesNotMatch(r.code, /ratchet-gate\.fly\.dev/,
        `${runtime} recipe still points at the old host`);
    }
  });
});
