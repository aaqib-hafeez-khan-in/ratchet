/**
 * Receipts.
 *
 * The point of these is that a customer can check us. So the tests that matter
 * are the ones where verification FAILS: an audit that cannot detect tampering
 * is theatre, and worse than nothing because it manufactures confidence.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';
import {
  signBody, verifyReceipt, receiptPublicKey, canonicalBody,
  chainPendingReceipts, receiptsFor, auditChain, RECEIPT_VERSION,
} from '../../src/domain/receipts.js';

const { beginEffect } = await import('../../src/domain/effects.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const begin = (key: string, cost = 0) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'payment.charge', idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: cost,
});

const body = (over: Record<string, unknown> = {}) => ({
  v: RECEIPT_VERSION, workspace_id: 'ws_1', effect_id: 'eff_1',
  effect_type: 'payment.charge', idempotency_key: 'k', decision: 'execute',
  state: 'pending', attempt: 1, payload_fingerprint: 'abc',
  decided_at: '2026-08-31T00:00:00.000Z', ...over,
});

describe('receipt signatures', () => {
  test('a genuine receipt verifies against the published key', () => {
    const s = signBody(body());
    assert.ok(verifyReceipt(s.body, s.signature, receiptPublicKey()));
  });

  test('altering ANY field breaks the signature', () => {
    const s = signBody(body());
    for (const field of ['decision', 'attempt', 'effect_id', 'idempotency_key']) {
      const tampered = JSON.parse(s.body);
      tampered[field] = field === 'attempt' ? 99 : 'tampered';
      assert.equal(verifyReceipt(canonicalBody(tampered), s.signature), false,
        `tampering with ${field} was not detected`);
    }
  });

  test('a different key does not verify', () => {
    const s = signBody(body());
    assert.equal(verifyReceipt(s.body, s.signature, Buffer.alloc(32).toString('base64')), false);
  });

  test('canonical form is order-independent', () => {
    assert.equal(canonicalBody(body()), canonicalBody({ ...body() }));
  });
});

describe('receipts through the gate', () => {
  test('every decision leaves one, refusals included', async () => {
    const key = `rcpt-${Date.now()}`;
    await begin(key);
    await begin(key);   // refused

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM receipts r
        JOIN effects e ON e.id = r.effect_id
       WHERE r.workspace_id=$1 AND e.idempotency_key=$2`, [ws.workspaceId, key]);
    assert.equal(Number(rows[0]!.n), 2,
      'a refusal is exactly the decision a customer most needs evidence of');
  });

  test('the stored receipt verifies as fetched', async () => {
    const r = await begin(`rcpt-verify-${Date.now()}`);
    await chainPendingReceipts();
    const receipts = await receiptsFor(getPool(), ws.workspaceId, r.effectId);
    assert.ok(receipts.length >= 1);
    const rec = receipts[0]!;
    assert.ok(verifyReceipt(JSON.stringify(rec.body), rec.signature),
      'a receipt handed to a customer must verify with no further work');
    assert.equal((rec.body as { decision: string }).decision, 'execute');
  });
});

describe('chain audit', () => {
  test('a clean chain verifies', async () => {
    await begin(`chain-${Date.now()}`);
    await chainPendingReceipts();
    const r = await auditChain(getPool(), ws.workspaceId);
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.checked > 0);
  });

  test('an ALTERED receipt body is caught', async () => {
    const isolated = await freshWorkspace();
    await beginEffect({
      workspaceId: isolated.workspaceId, apiKeyId: isolated.key.id,
      apiKeyPrefix: isolated.key.prefix, keyDailyBudgetMicros: null,
      effectType: 'payment.charge', idempotencyKey: `tamper-${Date.now()}`,
      payload: {}, estimatedCostMicros: 0,
    });
    await chainPendingReceipts();
    assert.equal((await auditChain(getPool(), isolated.workspaceId)).ok, true);

    // Rewrite history the way an attacker with database access would.
    await getPool().query(
      `UPDATE receipts SET body = replace(body, '"execute"', '"denied"')
        WHERE workspace_id = $1`, [isolated.workspaceId]);

    const after = await auditChain(getPool(), isolated.workspaceId);
    assert.equal(after.ok, false, 'a rewritten decision must not pass the audit');
    assert.match(after.reason!, /hash|signature/);
  });

  test('a REMOVED receipt is caught', async () => {
    const isolated = await freshWorkspace();
    for (let i = 0; i < 3; i++) {
      await beginEffect({
        workspaceId: isolated.workspaceId, apiKeyId: isolated.key.id,
        apiKeyPrefix: isolated.key.prefix, keyDailyBudgetMicros: null,
        effectType: 'payment.charge', idempotencyKey: `del-${i}-${Date.now()}`,
        payload: {}, estimatedCostMicros: 0,
      });
    }
    await chainPendingReceipts();
    assert.equal((await auditChain(getPool(), isolated.workspaceId)).ok, true);

    // Deleting the middle link is the subtle attack: every signature that
    // remains is still valid. Only the chain catches it.
    await getPool().query(
      `DELETE FROM receipts WHERE workspace_id = $1 AND seq = 2`, [isolated.workspaceId]);

    const after = await auditChain(getPool(), isolated.workspaceId);
    assert.equal(after.ok, false, 'a deleted receipt must break the chain');
    assert.match(after.reason!, /discontinuous|removed/);
  });

  test('chaining is idempotent and does not renumber', async () => {
    const isolated = await freshWorkspace();
    await beginEffect({
      workspaceId: isolated.workspaceId, apiKeyId: isolated.key.id,
      apiKeyPrefix: isolated.key.prefix, keyDailyBudgetMicros: null,
      effectType: 'payment.charge', idempotencyKey: `idem-${Date.now()}`,
      payload: {}, estimatedCostMicros: 0,
    });
    await chainPendingReceipts();
    const before = await getPool().query(
      `SELECT seq, chain_hash FROM receipts WHERE workspace_id=$1 ORDER BY seq`,
      [isolated.workspaceId]);
    await chainPendingReceipts();
    const after = await getPool().query(
      `SELECT seq, chain_hash FROM receipts WHERE workspace_id=$1 ORDER BY seq`,
      [isolated.workspaceId]);
    assert.deepEqual(after.rows, before.rows, 'a second pass must be a no-op');
  });
});

describe('prevented-loss ledger', () => {
  // This endpoint shipped broken because nothing exercised it. The query names
  // real columns, and only a query that actually runs proves that.
  test('counts refusals and what they would have cost', async () => {
    const isolated = await freshWorkspace();
    const key = `prevent-${Date.now()}`;
    const call = () => beginEffect({
      workspaceId: isolated.workspaceId, apiKeyId: isolated.key.id,
      apiKeyPrefix: isolated.key.prefix, keyDailyBudgetMicros: null,
      effectType: 'payment.charge', idempotencyKey: key,
      payload: {}, estimatedCostMicros: 4_999_000,
    });
    await call();
    await call();   // refused

    const { rows } = await getPool().query<{ n: string; micros: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(e.reserved_micros),0)::text AS micros
         FROM receipts r JOIN effects e ON e.id = r.effect_id
        WHERE r.workspace_id = $1 AND r.decision IN ('duplicate','in_flight','blocked')`,
      [isolated.workspaceId]);
    assert.equal(Number(rows[0]!.n), 1, 'the refusal should be counted');
    assert.ok(Number(rows[0]!.micros) > 0,
      'a declared cost must survive into the ledger, or the number reads $0.00 forever');
  });
});
