// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The beacon. An agent that finds this service should be able to integrate
 * without a person, so the discovery chain has to actually resolve and the
 * code it hands out has to actually be code.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../helpers.js';

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const get = (url: string, headers = {}) => app.inject({ method: 'GET', url, headers });

describe('self-service integration', () => {
  test('the index needs no API key', async () => {
    const r = await get('/v1/integrate');
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.ok(b.runtimes.length >= 5);
    assert.ok(b.runtimes.some((x: any) => x.runtime === 'http'));
  });

  test('every advertised runtime actually resolves', async () => {
    const { runtimes } = (await get('/v1/integrate')).json();
    for (const { runtime } of runtimes) {
      const r = await get(`/v1/integrate?runtime=${runtime}`);
      assert.equal(r.statusCode, 200, `${runtime} did not resolve`);
      const b = r.json();
      // Not a length contest — a config block is legitimately short. This
      // only catches a recipe that is a placeholder rather than a thing to run.
      assert.ok(b.code.length > 120, `${runtime} returned a stub, not code`);
      assert.ok(b.filename && b.language, `${runtime} is missing filename/language`);
      assert.ok(b.notes.length > 0, `${runtime} has no guidance`);
    }
  });

  test('every recipe teaches the rule callers get wrong', async () => {
    const { runtimes } = (await get('/v1/integrate')).json();
    for (const { runtime } of runtimes) {
      const b = (await get(`/v1/integrate?runtime=${runtime}`)).json();
      const all = (b.code + b.notes.join(' ')).toLowerCase();
      assert.match(all, /idempotency key|idempotency_key/,
        `${runtime} never mentions the idempotency key`);
      // A recipe that derived a key from a timestamp would teach the one
      // mistake that silently disables the whole product.
      assert.doesNotMatch(b.code, /idempotency_key["']?\s*:\s*.{0,20}(uuid4?\(\)|Date\.now\(\)|time\.time\(\))/,
        `${runtime} derives a key from a non-deterministic value`);
    }
  });

  test('plain text is pipeable, not JSON', async () => {
    const r = await get('/v1/integrate?runtime=python', { accept: 'text/plain' });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'] as string, /text\/plain/);
    assert.doesNotMatch(r.body.trim().slice(0, 1), /[{[]/);
    assert.match(r.body, /import/);
  });

  test('an unknown runtime still points somewhere useful', async () => {
    const r = await get('/v1/integrate?runtime=cobol');
    assert.equal(r.statusCode, 404);
    const b = r.json();
    assert.ok(b.error.detail.known_runtimes.includes('http'));
    assert.match(b.error.message, /HTTPS POST/);
  });

  test('the discovery chain an agent walks is unbroken', async () => {
    const manifest = (await get('/.well-known/agent-manifest.json')).json();
    assert.ok(manifest.integrate_url, 'manifest does not advertise the beacon');
    const llms = (await get('/llms.txt')).body;
    assert.match(llms, /\/v1\/integrate/, 'llms.txt does not point at the beacon');
    // And the link the manifest gives actually works.
    const path = new URL(manifest.integrate_url).pathname;
    assert.equal((await get(path)).statusCode, 200);
  });
});
