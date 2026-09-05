// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * x402 machine payments.
 *
 * Two properties carry all the risk, and neither is about cryptography:
 *
 *   Access is granted only after SETTLE, never after VERIFY. A valid signature
 *   is not a payment.
 *
 *   An authorization is honoured at most once. This is the product's own
 *   guarantee applied to its own billing, and it is enforced by a unique index
 *   rather than by a check-then-insert that would race.
 *
 * The facilitator is stubbed: what is being tested is our ordering and our
 * refusals, not somebody else's chain.
 */
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';

process.env.X402_FACILITATOR_URL = 'https://facilitator.test';
process.env.X402_PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
process.env.X402_NETWORK = 'eip155:1';
process.env.X402_AMOUNT = '1000000';
process.env.X402_CREDIT_MICROS = '1000000';

const { settlePayment, paymentRequired, x402Enabled, encodeHeader, decodePayload, PaymentError } =
  await import('../../src/domain/x402.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); mock.restoreAll(); });

const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';

const payload = (over: Record<string, unknown> = {}) => ({
  x402Version: 2,
  payload: {
    signature: '0x' + 'ab'.repeat(65),
    authorization: {
      from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
      to: PAY_TO,
      value: '1000000',
      validAfter: '1740672089',
      validBefore: '9740672154',
      nonce: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'),
      ...(over.authorization as object ?? {}),
    },
    ...(over.payloadOver as object ?? {}),
  },
});

/** Stub the facilitator. `calls` records the order so ordering can be asserted. */
function stubFacilitator(opts: { verify?: unknown; settle?: unknown; failOn?: string } = {}) {
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (opts.failOn === path) {
      return new Response('boom', { status: 500 });
    }
    const body = path === '/verify'
      ? (opts.verify ?? { isValid: true })
      : (opts.settle ?? { success: true, transaction: '0xdeadbeef' });
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe('x402 configuration', () => {
  test('enabled only with a facilitator and a payee', () => {
    assert.equal(x402Enabled(), true);
  });

  test('the 402 body follows the wire format', () => {
    const p = paymentRequired('https://ratchetgate.com/v1/effects/begin');
    assert.equal(p.x402Version, 2);
    const a = p.accepts[0]!;
    assert.equal(a.scheme, 'exact');
    assert.match(a.network, /^eip155:\d+$/);
    assert.equal(a.payTo, PAY_TO);
    // Base units, not a fiat string: quoting exchange rates is not our business.
    assert.match(a.amount, /^\d+$/);
    assert.equal(a.extra?.assetTransferMethod, 'eip3009');
  });

  test('the header round-trips', () => {
    const p = paymentRequired('https://x.test/r');
    assert.deepEqual(decodePayload(encodeHeader(p)), p as never);
    assert.equal(decodePayload('not base64 json'), null);
  });
});

describe('x402 settlement', () => {
  test('verify runs before settle, and credit lands only after settle', async () => {
    const before = await getPool().query<{ c: string }>(
      'SELECT credit_micros::text AS c FROM workspaces WHERE id=$1', [ws.workspaceId]);
    const calls = stubFacilitator();

    const r = await settlePayment({
      workspaceId: ws.workspaceId, payload: payload(), resourceUrl: 'https://x.test/r',
    });
    assert.deepEqual(calls, ['/verify', '/settle'], 'verify must precede settle');
    assert.equal(r.settlementRef, '0xdeadbeef');

    const after = await getPool().query<{ c: string }>(
      'SELECT credit_micros::text AS c FROM workspaces WHERE id=$1', [ws.workspaceId]);
    assert.equal(Number(after.rows[0]!.c) - Number(before.rows[0]!.c), 1_000_000);
    mock.restoreAll();
  });

  test('a valid signature that does NOT settle grants nothing', async () => {
    const w = await freshWorkspace();
    // The facilitator says the authorization is fine, then settlement fails.
    stubFacilitator({ settle: { success: false, errorReason: 'insufficient_funds' } });

    await assert.rejects(
      () => settlePayment({ workspaceId: w.workspaceId, payload: payload(),
                            resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'settlement_failed');

    const { rows } = await getPool().query<{ c: string }>(
      'SELECT credit_micros::text AS c FROM workspaces WHERE id=$1', [w.workspaceId]);
    assert.equal(Number(rows[0]!.c), 0, 'a signature is not a payment');
    mock.restoreAll();
  });

  test('an authorization rejected at verify never reaches settle', async () => {
    const w = await freshWorkspace();
    const calls = stubFacilitator({ verify: { isValid: false, invalidReason: 'bad_signature' } });
    await assert.rejects(
      () => settlePayment({ workspaceId: w.workspaceId, payload: payload(),
                            resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'payment_invalid');
    assert.deepEqual(calls, ['/verify'], 'settle must not be attempted');
    mock.restoreAll();
  });

  test('the same authorization cannot be settled twice', async () => {
    const w = await freshWorkspace();
    stubFacilitator();
    const p = payload();
    await settlePayment({ workspaceId: w.workspaceId, payload: p, resourceUrl: 'https://x.test/r' });

    // Replaying the identical nonce is the attack this product exists to stop,
    // applied to its own billing.
    await assert.rejects(
      () => settlePayment({ workspaceId: w.workspaceId, payload: p,
                            resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'payment_replayed');
    mock.restoreAll();
  });

  test('a nonce cannot be reused across workspaces either', async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    stubFacilitator();
    const p = payload();
    await settlePayment({ workspaceId: a.workspaceId, payload: p, resourceUrl: 'https://x.test/r' });
    await assert.rejects(
      () => settlePayment({ workspaceId: b.workspaceId, payload: p,
                            resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'payment_replayed');
    mock.restoreAll();
  });

  test('an underpayment is refused without calling the facilitator', async () => {
    const w = await freshWorkspace();
    const calls = stubFacilitator();
    await assert.rejects(
      () => settlePayment({
        workspaceId: w.workspaceId,
        payload: payload({ authorization: { value: '1' } }),
        resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'insufficient_payment');
    // The client picks the amount it signs, so this can never be taken on trust.
    assert.deepEqual(calls, [], 'no facilitator call should be spent on an underpayment');
    mock.restoreAll();
  });

  test('an authorization paying someone else is refused', async () => {
    const w = await freshWorkspace();
    stubFacilitator();
    await assert.rejects(
      () => settlePayment({
        workspaceId: w.workspaceId,
        payload: payload({ authorization: { to: '0x0000000000000000000000000000000000000001' } }),
        resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'wrong_recipient');
    mock.restoreAll();
  });

  test('a facilitator outage fails closed', async () => {
    const w = await freshWorkspace();
    stubFacilitator({ failOn: '/settle' });
    await assert.rejects(
      () => settlePayment({ workspaceId: w.workspaceId, payload: payload(),
                            resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'facilitator_error');
    const { rows } = await getPool().query<{ c: string }>(
      'SELECT credit_micros::text AS c FROM workspaces WHERE id=$1', [w.workspaceId]);
    assert.equal(Number(rows[0]!.c), 0, 'an outage must not grant free credit');
    mock.restoreAll();
  });

  test('a failed attempt keeps its nonce claimed', async () => {
    const w = await freshWorkspace();
    stubFacilitator({ failOn: '/settle' });
    const p = payload();
    await assert.rejects(() => settlePayment({ workspaceId: w.workspaceId, payload: p,
                                               resourceUrl: 'https://x.test/r' }));
    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM x402_payments WHERE nonce=$1',
      [p.payload.authorization.nonce]);
    assert.equal(rows[0]!.state, 'failed');
    // Still claimed, so it cannot be retried into a second settlement while the
    // first may still be in flight somewhere.
    mock.restoreAll();
    stubFacilitator();
    await assert.rejects(
      () => settlePayment({ workspaceId: w.workspaceId, payload: p,
                            resourceUrl: 'https://x.test/r' }),
      (e: InstanceType<typeof PaymentError>) => e.code === 'payment_replayed');
    mock.restoreAll();
  });

  test('no signature or nonce is stored', async () => {
    const w = await freshWorkspace();
    stubFacilitator();
    const p = payload();
    await settlePayment({ workspaceId: w.workspaceId, payload: p, resourceUrl: 'https://x.test/r' });
    const { rows } = await getPool().query(
      'SELECT * FROM x402_payments WHERE nonce=$1', [p.payload.authorization.nonce]);
    const stored = JSON.stringify(rows[0]);
    assert.ok(!stored.includes(p.payload.signature),
      'a stored signature is a replayable credential');
    mock.restoreAll();
  });
});
