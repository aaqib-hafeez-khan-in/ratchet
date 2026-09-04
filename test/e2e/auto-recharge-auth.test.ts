// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Who may switch on automatic charging of the owner's card.
 *
 * Not the agent. An agent that could enable this would be able to fund its own
 * overspending — the same failure as an agent raising its own budget ceiling,
 * and refused for the same reason. The budget is a control the agent is subject
 * to, not one it administers.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, getPool, keyWithScopes } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace } = await import('../../src/domain/auth.js');
const { CREDIT_PACKS } = await import('../../src/domain/billing.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const PACK = CREDIT_PACKS[0]!;

async function workspaceWithCard() {
  const label = `ar-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ws = await createWorkspace(label, `${label}@example.test`, false);
  await getPool().query(
    "UPDATE workspaces SET stripe_customer_id = 'cus_e2e' WHERE id = $1", [ws.workspaceId]);
  return ws;
}

const put = (key: string, body: unknown) => app.inject({
  method: 'PUT', url: '/v1/billing/auto-recharge',
  headers: { authorization: `Bearer ${key}` }, payload: body as never,
});

describe('only an operator can turn it on', () => {
  test('an agent key is refused', async () => {
    const ws = await workspaceWithCard();
    // Exactly the scopes signup hands an agent.
    const agent = await keyWithScopes(ws.workspaceId,
      ['effects:begin', 'effects:report', 'effects:read']);

    const r = await put(agent.plaintext, {
      enabled: true, threshold_micros: 1_000_000, pack_id: PACK.id });
    assert.ok(r.statusCode === 403 || r.statusCode === 401,
      `an agent key must not enable automatic charging, got ${r.statusCode}`);

    const { rows } = await getPool().query<{ auto_recharge_enabled: boolean }>(
      'SELECT auto_recharge_enabled FROM workspaces WHERE id = $1', [ws.workspaceId]);
    assert.equal(rows[0]!.auto_recharge_enabled, false,
      'the refusal must also not have changed anything');
  });

  test('an operator key with workspace:read may', async () => {
    const ws = await workspaceWithCard();
    const op = await keyWithScopes(ws.workspaceId, ['workspace:read']);
    const r = await put(op.plaintext, {
      enabled: true, threshold_micros: 1_000_000, pack_id: PACK.id });
    assert.equal(r.statusCode, 200, r.payload.slice(0, 200));
    assert.equal(JSON.parse(r.payload).enabled, true);
  });
});

describe('the endpoint refuses what the domain refuses', () => {
  test('a threshold above the pack size is a 400, not a surprise', async () => {
    const ws = await workspaceWithCard();
    const op = await keyWithScopes(ws.workspaceId, ['workspace:read']);
    const r = await put(op.plaintext, {
      enabled: true, threshold_micros: PACK.creditMicros + 1, pack_id: PACK.id });
    assert.equal(r.statusCode, 400);
    assert.match(JSON.parse(r.payload).error.message, /below the pack size/);
  });

  test('an unknown pack is rejected by the schema, not the handler', async () => {
    const ws = await workspaceWithCard();
    const op = await keyWithScopes(ws.workspaceId, ['workspace:read']);
    const r = await put(op.plaintext, {
      enabled: true, threshold_micros: 1_000_000, pack_id: 'pack_free_money' });
    assert.equal(r.statusCode, 400);
  });

  test('reading the settings says whether a card is on file', async () => {
    const ws = await workspaceWithCard();
    const op = await keyWithScopes(ws.workspaceId, ['workspace:read']);
    const r = await app.inject({
      method: 'GET', url: '/v1/billing/auto-recharge',
      headers: { authorization: `Bearer ${op.plaintext}` } });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.card_on_file, true);
    assert.equal(body.enabled, false, 'it must be off until somebody turns it on');
    assert.ok(body.max_per_day >= 1, 'the daily cap should be visible, not hidden');
  });
});
