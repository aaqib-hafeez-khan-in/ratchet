// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { freshWorkspace, closePool, getPool } from '../helpers.js';

const { deliverDue, signPayload } = await import('../../src/worker/webhooks.js');
const { enqueueEvent } = await import('../../src/domain/events.js');
type EventType = Parameters<typeof enqueueEvent>[2];
const { withTx } = await import('../../src/db/pool.js');
const { newId } = await import('../../src/lib/ids.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
let server: Server;
let port: number;
let received: Array<{ headers: Record<string, any>; body: string }> = [];
let nextStatus = 200;

before(async () => {
  ws = await freshWorkspace(false);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, any>, body });
      if (nextStatus >= 300 && nextStatus < 400) {
        res.writeHead(nextStatus, { location: 'http://127.0.0.1:1/evil' });
      } else {
        res.writeHead(nextStatus);
      }
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closePool();
});

async function endpoint(url: string, events = ['effect.succeeded']) {
  // Retire earlier endpoints so each test observes exactly one destination;
  // enqueueEvent fans out to every subscriber, which would otherwise look
  // like duplicate delivery.
  await getPool().query(
    'UPDATE webhook_endpoints SET disabled_at = now() WHERE workspace_id = $1', [ws.workspaceId]);
  const id = newId('whe');
  const secret = 'test_secret_value';
  await getPool().query(
    `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events) VALUES ($1,$2,$3,$4,$5)`,
    [id, ws.workspaceId, url, secret, events]);
  return { id, secret };
}

async function emit(payload: Record<string, unknown>,
                    type: EventType = 'effect.succeeded') {
  await withTx((tx) => enqueueEvent(tx, ws.workspaceId, type, payload));
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) if ((await deliverDue()) === 0) break;
}

describe('webhook delivery', () => {
  test('delivers a signed payload a receiver can verify', async () => {
    received = []; nextStatus = 200;
    const ep = await endpoint(`http://127.0.0.1:${port}/hook`);
    await emit({ effectId: 'eff_1' });
    await drain();

    assert.equal(received.length, 1);
    const got = received[0]!;
    const sigHeader = got.headers['ratchet-signature'] as string;
    const ts = Number(got.headers['ratchet-timestamp']);
    const deliveryId = got.headers['ratchet-delivery-id'] as string;

    // Reproduce the signature exactly as a customer's receiver would.
    const expected = createHmac('sha256', ep.secret)
      .update(`${ts}.${deliveryId}.${got.body}`).digest('hex');
    assert.equal(sigHeader, `t=${ts},v1=${expected}`);
    assert.equal(signPayload(ep.secret, ts, deliveryId, got.body), expected);

    const parsed = JSON.parse(got.body);
    assert.equal(parsed.type, 'effect.succeeded');
    assert.equal(parsed.data.effectId, 'eff_1');
    assert.equal(got.headers['idempotency-key'], deliveryId);

    const { rows } = await getPool().query(
      'SELECT state, attempts FROM webhook_deliveries WHERE endpoint_id=$1', [ep.id]);
    assert.equal(rows[0].state, 'delivered');
  });

  test('a tampered body fails the receiver-side check', async () => {
    received = []; nextStatus = 200;
    const ep = await endpoint(`http://127.0.0.1:${port}/hook2`);
    await emit({ effectId: 'eff_tamper' });
    await drain();
    const got = received[0]!;
    const ts = Number(got.headers['ratchet-timestamp']);
    const id = got.headers['ratchet-delivery-id'] as string;
    const forged = createHmac('sha256', ep.secret)
      .update(`${ts}.${id}.${got.body}TAMPERED`).digest('hex');
    assert.notEqual(`t=${ts},v1=${forged}`, got.headers['ratchet-signature']);
  });

  test('the same logical event is never delivered twice to one endpoint', async () => {
    received = []; nextStatus = 200;
    const ep = await endpoint(`http://127.0.0.1:${port}/hook3`);
    const payload = { effectId: 'eff_dedupe', attempt: 1 };
    await emit(payload);
    await emit(payload);
    await emit(payload);
    await drain();
    assert.equal(received.length, 1, 'duplicate enqueues must collapse to one delivery');
    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id=$1', [ep.id]);
    assert.equal(rows[0].n, 1);
  });

  test('a 4xx is treated as permanent and dead-lettered', async () => {
    received = []; nextStatus = 400;
    const ep = await endpoint(`http://127.0.0.1:${port}/hook4`);
    await emit({ effectId: 'eff_4xx' });
    await drain();
    const { rows } = await getPool().query(
      'SELECT state, attempts, last_status FROM webhook_deliveries WHERE endpoint_id=$1', [ep.id]);
    assert.equal(rows[0].state, 'dead');
    assert.equal(rows[0].last_status, 400);
    assert.equal(rows[0].attempts, 1, 'a permanent rejection must not be retried');
  });

  test('a 5xx is retried with backoff rather than dropped', async () => {
    received = []; nextStatus = 503;
    const ep = await endpoint(`http://127.0.0.1:${port}/hook5`);
    await emit({ effectId: 'eff_5xx' });
    await deliverDue();
    const { rows } = await getPool().query(
      'SELECT state, attempts, next_attempt_at > now() AS scheduled FROM webhook_deliveries WHERE endpoint_id=$1',
      [ep.id]);
    assert.equal(rows[0].state, 'queued');
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].scheduled, true, 'a retry must be scheduled into the future');
  });

  test('a redirect is refused rather than followed', async () => {
    received = []; nextStatus = 302;
    const ep = await endpoint(`http://127.0.0.1:${port}/hook6`);
    await emit({ effectId: 'eff_redirect' });
    await drain();
    const { rows } = await getPool().query(
      'SELECT state, last_error FROM webhook_deliveries WHERE endpoint_id=$1', [ep.id]);
    assert.equal(rows[0].state, 'dead');
    assert.match(rows[0].last_error, /redirect/i);
  });

  test('only subscribed event types are delivered', async () => {
    received = []; nextStatus = 200;
    const ep = await endpoint(`http://127.0.0.1:${port}/hook7`, ['effect.indeterminate']);
    await emit({ effectId: 'eff_wrongtype' }, 'effect.succeeded');
    await drain();
    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id=$1', [ep.id]);
    assert.equal(rows[0].n, 0);
  });
});

describe('delivery failure handling', () => {
  test('an unreachable destination is recorded and retried, not silently dropped', async () => {
    received = [];
    // Port 1 on loopback: the connection is refused immediately.
    const ep = await endpoint('http://127.0.0.1:1/hook');
    await emit({ effectId: 'eff_refused' });
    await deliverDue();
    const { rows } = await getPool().query(
      'SELECT state, attempts, last_error FROM webhook_deliveries WHERE endpoint_id=$1', [ep.id]);
    assert.equal(rows[0].state, 'queued');
    assert.ok(rows[0].last_error, 'the failure reason must be recorded for the operator');
  });
});
