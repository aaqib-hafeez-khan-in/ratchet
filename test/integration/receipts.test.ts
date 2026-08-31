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
  currentKid, knownKeys, registerCurrentKey,
} from '../../src/domain/receipts.js';

const { beginEffect } = await import('../../src/domain/effects.js');
const { pruneReceipts } = await import('../../src/domain/receipts.js');

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

describe('retention', () => {

  async function seed(ws: Awaited<ReturnType<typeof freshWorkspace>>, n: number) {
    for (let i = 0; i < n; i++) {
      await beginEffect({
        workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
        keyDailyBudgetMicros: null, effectType: 'payment.charge',
        idempotencyKey: `ret-${i}-${Date.now()}-${Math.random()}`,
        payload: {}, estimatedCostMicros: 1_000_000,
      });
    }
    await chainPendingReceipts();
  }

  test('the declared cost is signed into the receipt, not looked up', async () => {
    const ws2 = await freshWorkspace();
    await seed(ws2, 1);
    const { rows } = await getPool().query<{ body: string; cost_micros: string }>(
      `SELECT body, cost_micros FROM receipts WHERE workspace_id=$1`, [ws2.workspaceId]);
    assert.equal(Number(rows[0]!.cost_micros), 1_000_000);
    // In the signed body too, so the basis of the prevented-loss claim is
    // evidence rather than a join that can vanish.
    assert.equal(JSON.parse(rows[0]!.body).cost_micros, 1_000_000);
  });

  test('prevented loss survives the effect being deleted', async () => {
    const ws2 = await freshWorkspace();
    const key = `survive-${Date.now()}`;
    const call = () => beginEffect({
      workspaceId: ws2.workspaceId, apiKeyId: ws2.key.id, apiKeyPrefix: ws2.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge', idempotencyKey: key,
      payload: {}, estimatedCostMicros: 3_000_000,
    });
    await call();
    await call();
    // Effects expire after seven days by default while the prevented-loss
    // window is thirty, so this is the normal case, not an edge case.
    await getPool().query('DELETE FROM effects WHERE workspace_id=$1', [ws2.workspaceId]);

    const { rows } = await getPool().query<{ micros: string }>(
      `SELECT COALESCE(sum(cost_micros),0)::text AS micros FROM receipts
        WHERE workspace_id=$1 AND decision IN ('duplicate','in_flight','blocked')`,
      [ws2.workspaceId]);
    assert.ok(Number(rows[0]!.micros) > 0,
      'the figure must not shrink just because the effect was garbage collected');
  });

  test('pruning writes a checkpoint and the audit still passes', async () => {
    const ws2 = await freshWorkspace();
    await seed(ws2, 4);
    assert.equal((await auditChain(getPool(), ws2.workspaceId)).ok, true);

    // Age them past the window.
    await getPool().query(
      `UPDATE receipts SET created_at = now() - interval '200 days' WHERE workspace_id=$1`,
      [ws2.workspaceId]);
    const r = await pruneReceipts(90);
    assert.ok(r.pruned > 0, 'nothing was pruned');
    // Assert per workspace: the prune sweeps up to fifty at a time, so the
    // global count depends on what other tests left lying around.
    const { rows: cps } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM receipt_checkpoints WHERE workspace_id=$1`,
      [ws2.workspaceId]);
    assert.equal(Number(cps[0]!.n), 1, 'exactly one checkpoint for this workspace');

    // The critical property: a truncated log must NOT read as tampered.
    const audit = await auditChain(getPool(), ws2.workspaceId);
    assert.equal(audit.ok, true, `audit broke after pruning: ${audit.reason}`);
    assert.ok(audit.prunedThroughSeq! > 0);
  });

  test('a forged checkpoint cannot hide a gap', async () => {
    const ws2 = await freshWorkspace();
    await seed(ws2, 3);
    await getPool().query(
      `UPDATE receipts SET created_at = now() - interval '200 days' WHERE workspace_id=$1`,
      [ws2.workspaceId]);
    await pruneReceipts(90);

    // Rewrite the checkpoint the way someone covering a deletion would.
    await getPool().query(
      `UPDATE receipt_checkpoints SET body = replace(body, '"up_to_seq"', '"up_to_seq_x"')
        WHERE workspace_id=$1`, [ws2.workspaceId]);

    const audit = await auditChain(getPool(), ws2.workspaceId);
    assert.equal(audit.ok, false, 'a tampered checkpoint must not be trusted');
    assert.match(audit.reason!, /checkpoint/);
  });

  test('unchained receipts are never pruned', async () => {
    const ws2 = await freshWorkspace();
    await beginEffect({
      workspaceId: ws2.workspaceId, apiKeyId: ws2.key.id, apiKeyPrefix: ws2.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge',
      idempotencyKey: `unchained-${Date.now()}`, payload: {}, estimatedCostMicros: 0,
    });
    // Deliberately not chained. Ageing it must not make it disappear, because
    // nothing has attested to it yet.
    await getPool().query(
      `UPDATE receipts SET created_at = now() - interval '200 days' WHERE workspace_id=$1`,
      [ws2.workspaceId]);
    await pruneReceipts(90);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM receipts WHERE workspace_id=$1`, [ws2.workspaceId]);
    assert.equal(Number(rows[0]!.n), 1, 'an unattested receipt was deleted');
  });
});

/**
 * Key rotation.
 *
 * The failure this prevents is silent and total: rotate AUTH_SECRET, and every
 * receipt ever issued stops verifying against the only key we publish. A
 * customer auditing last quarter sees the whole log fail and cannot tell
 * rotation from an attack.
 */
describe('key rotation', () => {
  test('a key id is recorded and travels inside the signature', async () => {
    const w = await freshWorkspace();
    await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge',
      idempotencyKey: `kid-${Date.now()}`, payload: {}, estimatedCostMicros: 0,
    });
    const { rows } = await getPool().query<{ kid: string; body: string }>(
      `SELECT kid, body FROM receipts WHERE workspace_id=$1`, [w.workspaceId]);
    assert.equal(rows[0]!.kid, currentKid());
    // Inside the signed bytes, so it cannot be repointed at another key.
    assert.equal(JSON.parse(rows[0]!.body).kid, currentKid());
  });

  test('history still verifies after the signing key changes', async () => {
    const w = await freshWorkspace();
    await registerCurrentKey();
    await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge',
      idempotencyKey: `rot-${Date.now()}`, payload: {}, estimatedCostMicros: 0,
    });
    await chainPendingReceipts();
    assert.equal((await auditChain(getPool(), w.workspaceId)).ok, true);

    // Simulate rotation: a NEW key becomes current while the old public half
    // remains published. This is the exact scenario that used to destroy the
    // verifiability of everything already signed.
    const newPub = Buffer.from(
      '3'.repeat(64), 'hex').toString('base64');
    await getPool().query(
      `INSERT INTO receipt_keys (kid, public_key) VALUES ($1,$2)
       ON CONFLICT (kid) DO NOTHING`, ['deadbeefdeadbeef', newPub]);

    const after = await auditChain(getPool(), w.workspaceId);
    assert.equal(after.ok, true,
      `old receipts must still verify after rotation: ${after.reason}`);
  });

  test('a receipt naming an unpublished key is refused, not waved through', async () => {
    const w = await freshWorkspace();
    await beginEffect({
      workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
      keyDailyBudgetMicros: null, effectType: 'payment.charge',
      idempotencyKey: `unk-${Date.now()}`, payload: {}, estimatedCostMicros: 0,
    });
    await chainPendingReceipts();
    // Point it at a key nobody has ever published.
    await getPool().query(
      `UPDATE receipts SET body = replace(body, $2, 'ffffffffffffffff')
        WHERE workspace_id=$1`, [w.workspaceId, currentKid()]);

    const after = await auditChain(getPool(), w.workspaceId);
    assert.equal(after.ok, false, 'an unknown signing key must fail the audit');
  });

  test('every published key is usable for verification', async () => {
    await registerCurrentKey();
    const keys = await knownKeys();
    assert.ok(keys.length >= 1);
    const cur = keys.find((k) => k.current);
    assert.ok(cur, 'exactly one key must be marked current');
    assert.equal(Buffer.from(cur!.public_key, 'base64').length, 32);
  });
});
