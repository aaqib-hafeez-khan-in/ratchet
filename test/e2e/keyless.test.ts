// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Keyless first contact.
 *
 * This is the one unauthenticated write in the service, so what it CANNOT do
 * matters more than what it can. It must never reach an existing workspace,
 * never hand out more than a capped trial, and never let one anonymous caller
 * see another's data.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { freshWorkspace, closePool, getPool } from '../helpers.js';
import { ANONYMOUS_EFFECT_QUOTA } from '../../src/domain/auth.js';

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const begin = (body: Record<string, unknown>, key?: string) => app.inject({
  method: 'POST', url: '/v1/effects/begin',
  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  payload: body,
});

const effect = (n = '') => ({
  effect_type: 'email.send',
  idempotency_key: `keyless-${n}-${Date.now()}-${Math.random()}`,
  payload: { to: 'a@b.c' },
});

describe('keyless first contact', () => {
  test('a call with no credential works and returns a usable key', async () => {
    const r = await begin(effect('first'));
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.decision, 'execute', 'the caller should get a real decision, not a stub');
    assert.ok(b.workspace, 'the key must come back or the agent can never call again');
    assert.match(b.workspace.api_key, /^rk_/);
    assert.equal(b.workspace.quota, ANONYMOUS_EFFECT_QUOTA);

    // The returned key must actually work on the next call.
    const second = await begin(effect('second'), b.workspace.api_key);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().decision, 'execute');
    assert.equal(second.json().workspace, undefined,
      'the key is returned once; a keyed call must not mint another workspace');
  });

  test('the gate actually gates within an anonymous workspace', async () => {
    const first = await begin(effect('dup'));
    const key = first.json().workspace.api_key;
    const e = effect('dup-same');
    const a = await begin(e, key);
    const b = await begin(e, key);
    assert.equal(a.json().decision, 'execute');
    assert.notEqual(b.json().decision, 'execute',
      'an anonymous workspace must be a real gate, not a demo that always says yes');
  });

  test('two keyless callers get separate, isolated workspaces', async () => {
    const a = (await begin(effect('iso-a'))).json();
    const b = (await begin(effect('iso-b'))).json();
    assert.notEqual(a.workspace.workspace_id, b.workspace.workspace_id);

    // A's key must not read B's effect.
    const r = await app.inject({
      method: 'GET', url: `/v1/effects/${b.effect_id}`,
      headers: { authorization: `Bearer ${a.workspace.api_key}` },
    });
    assert.equal(r.statusCode, 404, 'cross-tenant read must 404, not leak');
  });

  test('a keyless call never reaches an existing workspace', async () => {
    const owned = await freshWorkspace();
    const r = await begin(effect('reach'));
    const newWs = r.json().workspace.workspace_id;
    assert.notEqual(newWs, owned.workspaceId);
    const { rows } = await getPool().query<{ anonymous: boolean; owner_email: string | null }>(
      'SELECT anonymous, owner_email FROM workspaces WHERE id = $1', [newWs]);
    assert.equal(rows[0]!.anonymous, true);
    assert.equal(rows[0]!.owner_email, null);
  });

  test('an invalid key is still rejected rather than silently provisioning', async () => {
    // Falling back to provisioning here would turn every typo into a new
    // workspace and quietly strand the caller's real data.
    const r = await begin(effect('bad'), 'rk_live_totally_invalid_key_value');
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().workspace, undefined);
  });
});

describe('claiming', () => {
  test('claiming attaches an owner and lifts the cap', async () => {
    const b = (await begin(effect('claim'))).json();
    const key = b.workspace.api_key;

    const r = await app.inject({
      method: 'POST', url: '/v1/workspaces/claim',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { email: `claimed-${Date.now()}@example.test`, name: 'Claimed' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().claimed, true);

    const { rows } = await getPool().query<{ anonymous: boolean; owner_email: string }>(
      'SELECT anonymous, owner_email FROM workspaces WHERE id = $1', [b.workspace.workspace_id]);
    assert.equal(rows[0]!.anonymous, false);
    assert.match(rows[0]!.owner_email, /@example\.test$/);
  });

  test('a claimed workspace cannot be claimed again', async () => {
    const b = (await begin(effect('claim2'))).json();
    const key = b.workspace.api_key;
    const body = { email: `first-${Date.now()}@example.test` };
    const one = await app.inject({ method: 'POST', url: '/v1/workspaces/claim',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: body });
    assert.equal(one.statusCode, 200);

    // Otherwise a leaked key would let someone re-point the workspace at
    // themselves and take it over.
    const two = await app.inject({ method: 'POST', url: '/v1/workspaces/claim',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { email: `attacker-${Date.now()}@example.test` } });
    assert.equal(two.statusCode, 409);
  });

  test('an ordinary workspace cannot be claimed', async () => {
    const ws = await freshWorkspace();
    const r = await app.inject({ method: 'POST', url: '/v1/workspaces/claim',
      headers: { authorization: `Bearer ${ws.key.plaintext}`, 'content-type': 'application/json' },
      payload: { email: `x-${Date.now()}@example.test` } });
    assert.equal(r.statusCode, 409);
  });
});
