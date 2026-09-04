// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SOLANA_DESTINATION_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

const { freshWorkspace, closePool, getPool } = await import('../helpers.js');
const { createIntent, creditConfirmedPayment, listAssets, cryptoEnabled,
        expireStaleIntents, CryptoUnavailable } = await import('../../src/domain/crypto.js');
const { getBilling, listLedger } = await import('../../src/domain/metering.js');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(false); });
after(async () => { await closePool(); });

describe('non-custodial crypto payments', () => {
  test('only operator-enabled assets are quotable', async () => {
    const assets = await listAssets(getPool(), true);
    assert.ok(assets.some((a) => a.symbol === 'USDC'));
    await assert.rejects(
      () => createIntent({ workspaceId: ws.workspaceId, tokenMint: 'SomeRandomMemeMint', usdMicros: 25_000_000 }),
      (e: any) => e.code === 'invalid_request',
      'a payer must not be able to introduce an asset',
    );
  });

  test('a stable asset quotes at parity, in USD', async () => {
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, chain: 'solana', usdMicros: 25_000_000 });
    assert.equal(i.symbol, 'USDC');
    assert.equal(i.usdMicros, 25_000_000);
    assert.equal(i.tokenAmount, '25000000', '$25 of a 6-decimal stable token');
    assert.equal(i.destination, process.env.SOLANA_DESTINATION_ADDRESS);
    assert.ok(i.memo.startsWith('ratchet-'));
    assert.equal(i.state, 'awaiting_payment');
  });

  test('a volatile asset with NO obtainable price is refused, not guessed', async () => {
    // A symbol no exchange lists. The oracle cannot reach two agreeing sources,
    // so quoting it would mean inventing a number.
    await getPool().query(
      `INSERT INTO crypto_assets (chain, token_mint, symbol, decimals, enabled, is_stable,
                                  quote_ttl_seconds, volatility_bps, min_usd_micros, attribution)
       VALUES ('solana','UnpriceableMint1','ZZZNOTATOKEN',6,true,false,60,500,5000000,'memo')
       ON CONFLICT DO NOTHING`);
    await assert.rejects(
      () => createIntent({ workspaceId: ws.workspaceId, tokenMint: 'UnpriceableMint1', usdMicros: 25_000_000 }),
      (e: Error) => {
        assert.ok(e instanceof CryptoUnavailable);
        assert.match(e.message, /Cannot price|usable price source/i);
        return true;
      },
      'an asset the oracle cannot price must be refused rather than guessed at',
    );
  });

  test('a volatile asset WITH agreeing sources is quotable, and carries its haircut', async () => {
    // BTC is priceable from two independent sources, so it can be quoted. The
    // haircut increases what the payer sends, absorbing price movement between
    // quote and confirmation; it never reduces the credit granted.
    const HAIRCUT_BPS = 250;
    await getPool().query(
      `INSERT INTO crypto_assets (chain, token_mint, symbol, decimals, enabled, is_stable,
                                  quote_ttl_seconds, volatility_bps, min_usd_micros,
                                  required_confirmations, attribution)
       VALUES ('bitcoin','native','BTC',8,true,false,300,$1,25000000,2,'tx_submission')
       ON CONFLICT (chain, token_mint) DO UPDATE SET enabled = true, volatility_bps = $1`,
      [HAIRCUT_BPS]);

    let i;
    try {
      i = await createIntent({
        workspaceId: ws.workspaceId, tokenMint: 'native', chain: 'bitcoin', usdMicros: 25_000_000 });
    } catch (e) {
      // The oracle may legitimately refuse if the live sources disagree; that
      // is the guard working, not a failure of this test.
      assert.ok(e instanceof CryptoUnavailable);
      return;
    }

    assert.equal(i.symbol, 'BTC');
    assert.equal(i.usdMicros, 25_000_000, 'credit is the USD amount, whatever BTC does');

    const rate = Number(i.quotedRateUsd);
    assert.ok(rate > 1000, 'a plausible BTC price');
    const sats = Number(i.tokenAmount);
    const plain = (25 / rate) * 1e8;
    assert.ok(sats > plain, 'the haircut must make the payer send MORE, not less');
    assert.ok(sats < plain * 1.05, 'and only slightly more — 250bps, not a tax');
  });

  test('a confirmed payment credits the USD amount, once', async () => {
    await getPool().query('UPDATE workspaces SET credit_micros = 0 WHERE id = $1', [ws.workspaceId]);
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 25_000_000 });

    const r = await creditConfirmedPayment({
      memo: i.memo, txSignature: 'sig_' + i.id, observedAmount: 25_000_000n, confirmations: 1 });
    assert.equal(r.credited, true);
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, 25_000_000);

    // Re-reading the chain must not credit again.
    for (let n = 0; n < 3; n++) {
      const again = await creditConfirmedPayment({
        memo: i.memo, txSignature: 'sig_' + i.id, observedAmount: 25_000_000n, confirmations: 6 });
      assert.equal(again.credited, false);
    }
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, 25_000_000);
    const topups = (await listLedger(getPool(), ws.workspaceId, 50)).filter((e) => e.kind === 'topup');
    assert.equal(topups.length, 1);
  });

  test('an overpayment credits only the quoted USD amount', async () => {
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 10_000_000 });
    // Token doubled in value, or the payer was generous. Credit is the quote.
    await creditConfirmedPayment({
      memo: i.memo, txSignature: 'sig_over_' + i.id, observedAmount: 99_000_000n, confirmations: 1 });
    const after = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    assert.equal(after - before, 10_000_000,
      'credit follows the USD quote, never the token amount received');
  });

  test('an underpayment credits nothing and is recorded for a human', async () => {
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 25_000_000 });
    const r = await creditConfirmedPayment({
      memo: i.memo, txSignature: 'sig_under_' + i.id, observedAmount: 24_000_000n, confirmations: 1 });
    assert.equal(r.credited, false);
    assert.equal(r.reason, 'underpaid');
    assert.equal((await getBilling(getPool(), ws.workspaceId))!.creditMicros, before,
      'a short payment must never be rounded up');
    const { rows } = await getPool().query(
      'SELECT state FROM crypto_intents WHERE memo = $1', [i.memo]);
    assert.equal(rows[0].state, 'underpaid');
  });

  test('a payment for an unknown memo credits nothing', async () => {
    const r = await creditConfirmedPayment({
      memo: 'ratchet-doesnotexist', txSignature: 'sig_x', observedAmount: 999n, confirmations: 1 });
    assert.equal(r.credited, false);
    assert.equal(r.reason, 'no intent for that memo');
  });

  test('memos are unique, so payments cannot be misattributed', async () => {
    const a = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 5_000_000 });
    const b = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 5_000_000 });
    assert.notEqual(a.memo, b.memo);
  });

  test('stale quotes expire rather than lingering as a free option', async () => {
    const i = await createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 5_000_000 });
    await getPool().query(
      `UPDATE crypto_intents SET expires_at = now() - interval '1 minute' WHERE memo = $1`, [i.memo]);
    assert.ok((await expireStaleIntents()) >= 1);
    const { rows } = await getPool().query('SELECT state FROM crypto_intents WHERE memo=$1', [i.memo]);
    assert.equal(rows[0].state, 'expired');
  });

  test('below the minimum is refused', async () => {
    await assert.rejects(
      () => createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 1_000_000 }),
      (e: any) => e.code === 'invalid_request');
  });

  test('crypto is off unless the operator configured a destination they control', async () => {
    assert.equal(cryptoEnabled(), true);

    // Crypto is available when ANY chain has a receiving address, so all of
    // them must be cleared to prove the off state.
    const CHAINS = ['SOLANA', 'ETHEREUM', 'BITCOIN'] as const;
    const saved = Object.fromEntries(
      CHAINS.map((c) => [c, process.env[`${c}_DESTINATION_ADDRESS`]]));
    for (const c of CHAINS) process.env[`${c}_DESTINATION_ADDRESS`] = '';

    assert.equal(cryptoEnabled(), false);
    await assert.rejects(
      () => createIntent({ workspaceId: ws.workspaceId, tokenMint: USDC, usdMicros: 25_000_000 }),
      (e: Error) => e instanceof CryptoUnavailable,
      'with nowhere to send funds, a quote would point at nothing');

    for (const c of CHAINS) {
      if (saved[c] === undefined) delete process.env[`${c}_DESTINATION_ADDRESS`];
      else process.env[`${c}_DESTINATION_ADDRESS`] = saved[c]!;
    }
  });
});
