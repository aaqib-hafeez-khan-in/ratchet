// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SOLANA_DESTINATION_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';

const { freshWorkspace, closePool, getPool } = await import('../helpers.js');
const { createIntent } = await import('../../src/domain/crypto.js');
const { getBilling } = await import('../../src/domain/metering.js');
const { watchChainOnce } = await import('../../src/worker/chain.js');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEST = process.env.SOLANA_DESTINATION_ADDRESS!;
let ws: Awaited<ReturnType<typeof freshWorkspace>>;

before(async () => { ws = await freshWorkspace(false); });
after(async () => { mock.restoreAll(); await closePool(); });

/**
 * Stubs the Solana JSON-RPC. The watcher's only job is observation — crediting
 * is already tested directly — so what matters here is that it reads memos and
 * balance deltas correctly and refuses everything it should.
 */
function stubRpc(signatures: any[], transactions: Record<string, any>) {
  mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const result = body.method === 'getSignaturesForAddress'
      ? signatures
      : transactions[body.params[0]] ?? null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** A transaction that moved `amount` of `mint` to the destination, with a memo. */
const txWith = (memo: string | null, amount: string, mint = USDC, owner = DEST) => ({
  meta: {
    logMessages: memo ? [`Program log: Memo (len ${memo.length}): "${memo}"`] : ['Program log: none'],
    preTokenBalances: [{ accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } }],
    postTokenBalances: [{ accountIndex: 1, mint, owner, uiTokenAmount: { amount } }],
  },
});

describe('solana chain watcher', () => {
  test('credits a confirmed transfer that matches an open intent', async () => {
    await getPool().query('UPDATE workspaces SET credit_micros = 0 WHERE id = $1', [ws.workspaceId]);
    const intent = await createIntent({
      workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 25_000_000 });

    stubRpc(
      [{ signature: 'sigA', err: null, confirmationStatus: 'finalized' }],
      { sigA: txWith(intent.memo, '25000000') },
    );

    const r = await watchChainOnce();
    assert.equal(r.credited, 1);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, 25_000_000);
  });

  test('re-scanning the same block credits nothing further', async () => {
    // The watcher is deliberately allowed to be at-least-once: idempotency
    // lives at the ledger, keyed on the transaction signature.
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const r = await watchChainOnce();
    assert.equal(r.credited, 0);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before);
  });

  test('a failed transaction is ignored', async () => {
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 10_000_000 });
    stubRpc([{ signature: 'sigFail', err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' }],
      { sigFail: txWith(i.memo, '10000000') });
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const r = await watchChainOnce();
    assert.equal(r.credited, 0);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before,
      'a transaction that errored moved nothing');
  });

  test('a transfer with no Ratchet memo is ignored', async () => {
    await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 10_000_000 });
    stubRpc([{ signature: 'sigNoMemo', err: null, confirmationStatus: 'finalized' }],
      { sigNoMemo: txWith(null, '10000000') });
    assert.equal((await watchChainOnce()).credited, 0);
  });

  test('a memo for an unknown intent is ignored', async () => {
    stubRpc([{ signature: 'sigUnknown', err: null, confirmationStatus: 'finalized' }],
      { sigUnknown: txWith('ratchet-notours', '10000000') });
    assert.equal((await watchChainOnce()).credited, 0);
  });

  test('too few confirmations waits rather than crediting early', async () => {
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 10_000_000 });
    await getPool().query(
      `UPDATE crypto_assets SET required_confirmations = 32 WHERE token_mint = $1`, [USDC]);
    stubRpc([{ signature: 'sigEarly', err: null, confirmationStatus: 'processed' }],
      { sigEarly: txWith(i.memo, '10000000') });
    assert.equal((await watchChainOnce()).credited, 0);
    await getPool().query(
      `UPDATE crypto_assets SET required_confirmations = 1 WHERE token_mint = $1`, [USDC]);
  });

  test('an underpaid transfer credits nothing', async () => {
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 25_000_000 });
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    stubRpc([{ signature: 'sigShort', err: null, confirmationStatus: 'finalized' }],
      { sigShort: txWith(i.memo, '24000000') });
    await watchChainOnce();
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before);
    const { rows } = await getPool().query('SELECT state FROM crypto_intents WHERE memo=$1', [i.memo]);
    assert.equal(rows[0].state, 'underpaid');
  });

  test('a transfer to a different owner is not counted', async () => {
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 10_000_000 });
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    stubRpc([{ signature: 'sigOther', err: null, confirmationStatus: 'finalized' }],
      { sigOther: txWith(i.memo, '10000000', USDC, 'SomeoneElsesAddress1111111111111111111111') });
    await watchChainOnce();
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before,
      'the balance delta must be measured on OUR address, not any address');
  });

  test('a different token to our address is not counted', async () => {
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 10_000_000 });
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    stubRpc([{ signature: 'sigWrongMint', err: null, confirmationStatus: 'finalized' }],
      { sigWrongMint: txWith(i.memo, '10000000', 'SomeOtherMint1111111111111111111111111111') });
    await watchChainOnce();
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before,
      'paying in the wrong asset must not settle a USDC quote');
  });

  test('no RPC call is made when nothing is owed', async () => {
    await getPool().query(
      `UPDATE crypto_intents SET state='expired' WHERE workspace_id=$1`, [ws.workspaceId]);
    let called = 0;
    mock.method(globalThis, 'fetch', async () => { called++; return new Response('{}'); });
    const r = await watchChainOnce();
    assert.equal(called, 0, 'polling a chain with no open intent is pure waste');
    assert.equal(r.scanned, 0);
  });
});
