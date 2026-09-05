// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SOLANA_DESTINATION_ADDRESS = 'BSLwtSUSyLhxoQDU9HhodEcoW6RPaVycTJnGHGpAcd13';
process.env.ETHEREUM_DESTINATION_ADDRESS = '0x2D96975f13E3e0426C5b0b140e7bDE2964cC9132';
process.env.BITCOIN_DESTINATION_ADDRESS = 'bc1qgncnewpst92crmsddg6yv63vmahyav340ttz4g';

const { freshWorkspace, closePool, getPool } = await import('../helpers.js');
const { createIntent, submitTransaction } = await import('../../src/domain/crypto.js');
const { getBilling } = await import('../../src/domain/metering.js');

// Ethereum, not Base: tx-submission is the attribution path for every EVM
// chain with no memo, and the fixture should be one this service accepts.
// The amounts moved from $10 to $25 with it — Ethereum's minimum is higher
// than Base's was, because L1 gas makes a small payment not worth making.
const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
let ws: Awaited<ReturnType<typeof freshWorkspace>>;

before(async () => {
  ws = await freshWorkspace(false);
  await getPool().query(`UPDATE crypto_assets SET enabled = true
    WHERE (chain,token_mint) IN (('ethereum',$1),('bitcoin','native'))`, [ETH_USDC]);
});
after(async () => { await closePool(); });

const hash = (n: string) => '0x' + n.padStart(64, '0');

/** Stands in for the chain: says yes to one hash, no to everything else. */
const verifierFor = (goodHash: string, amount: bigint) =>
  async (a: { txHash: string }) => a.txHash.toLowerCase() === goodHash.toLowerCase()
    ? { ok: true, amount, confirmations: 20 }
    : { ok: false, reason: 'no transfer of that asset to that address in this transaction' };

describe('transaction submission on chains without a memo', () => {
  test('a verified transfer credits the quoted USD amount', async () => {
    await getPool().query('UPDATE workspaces SET credit_micros = 0 WHERE id=$1', [ws.workspaceId]);
    const i = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    assert.match(i.instructions.join(' '), /submit your transaction hash/i,
      'a memo-less chain must tell the payer what to do instead');

    const tx = hash('a1');
    const r = await submitTransaction({
      workspaceId: ws.workspaceId, intentId: i.id, txHash: tx,
      verify: verifierFor(tx, 25_000_000n),
    });
    assert.equal(r.credited, true);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, 25_000_000);
  });

  test('the same transaction cannot settle a second quote', async () => {
    // The dangerous case: pay once, submit the hash against several quotes.
    const tx = hash('b2');
    const first = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    await submitTransaction({
      workspaceId: ws.workspaceId, intentId: first.id, txHash: tx,
      verify: verifierFor(tx, 25_000_000n) });

    const second = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    await assert.rejects(
      () => submitTransaction({
        workspaceId: ws.workspaceId, intentId: second.id, txHash: tx,
        verify: verifierFor(tx, 25_000_000n) }),
      (e: any) => e.code === 'transaction_already_used',
      'one payment must never be able to settle two quotes',
    );
  });

  test('resubmitting the same hash to the same intent does not double-credit', async () => {
    const tx = hash('c3');
    const i = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    await submitTransaction({ workspaceId: ws.workspaceId, intentId: i.id, txHash: tx,
      verify: verifierFor(tx, 25_000_000n) });
    const mid = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    assert.equal(mid - before, 25_000_000);

    const again = await submitTransaction({ workspaceId: ws.workspaceId, intentId: i.id, txHash: tx,
      verify: verifierFor(tx, 25_000_000n) });
    assert.equal(again.credited, false);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, mid);
  });

  test('a transaction that does not verify credits nothing and stays open', async () => {
    const i = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const r = await submitTransaction({
      workspaceId: ws.workspaceId, intentId: i.id, txHash: hash('d4'),
      verify: verifierFor(hash('ffff'), 10_000_000n),
    });
    assert.equal(r.credited, false);
    assert.equal(r.state, 'confirming');
    assert.match(r.reason!, /no transfer/);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before);
  });

  test('an underpaid but verified transfer credits nothing', async () => {
    const i = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const tx = hash('e5');
    const r = await submitTransaction({
      workspaceId: ws.workspaceId, intentId: i.id, txHash: tx,
      verify: verifierFor(tx, 24_000_000n),      // one dollar short
    });
    assert.equal(r.credited, false);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before);
  });

  test('a malformed hash is rejected before any chain call', async () => {
    const i = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    let called = false;
    await assert.rejects(
      () => submitTransaction({
        workspaceId: ws.workspaceId, intentId: i.id, txHash: 'not-a-hash',
        verify: async () => { called = true; return { ok: true, amount: 1n }; } }),
      (e: any) => e.code === 'invalid_request');
    assert.equal(called, false, 'garbage should never reach an RPC');
  });

  test('another workspace cannot submit against an intent it does not own', async () => {
    const other = await freshWorkspace(false);
    const i = await createIntent({
      workspaceId: ws.workspaceId, chain: 'ethereum', tokenMint: ETH_USDC, usdMicros: 25_000_000 });
    await assert.rejects(
      () => submitTransaction({
        workspaceId: other.workspaceId, intentId: i.id, txHash: hash('f6'),
        verify: verifierFor(hash('f6'), 10_000_000n) }),
      (e: any) => e.code === 'not_found');
  });
});
