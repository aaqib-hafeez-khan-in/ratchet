// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * The only code here that spends somebody's money without asking.
 *
 * A bug in it does not lose data — it takes money repeatedly from somebody who
 * trusted us, inside a product whose entire argument is that the same action
 * happens at most once. So these tests are about refusing, not about working:
 * the interesting assertions are all the ones where nothing is charged.
 */
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';

const AR = await import('../../src/domain/auto-recharge.js');
const { CREDIT_PACKS } = await import('../../src/domain/billing.js');

after(async () => { await closePool(); });

const PACK = CREDIT_PACKS[0]!;                       // the $25 pack
const THRESHOLD = Math.floor(PACK.creditMicros / 5); // comfortably below it

async function ready(opts: { balance?: number; card?: boolean; enabled?: boolean } = {}) {
  const ws = await freshWorkspace(false);
  await getPool().query(
    `UPDATE workspaces
        SET credit_micros = $2,
            stripe_customer_id = $3,
            auto_recharge_enabled = $4,
            auto_recharge_threshold_micros = $5,
            auto_recharge_pack_id = $6
      WHERE id = $1`,
    [ws.workspaceId, opts.balance ?? 0, opts.card === false ? null : 'cus_test123',
     opts.enabled ?? true, THRESHOLD, PACK.id]);
  return ws;
}

describe('claiming a charge', () => {
  test('a workspace below its threshold claims exactly one', async () => {
    const ws = await ready({ balance: 0 });
    const first = await AR.claimRecharge(ws.workspaceId);
    assert.ok(first, 'a workspace under its threshold should claim a recharge');
    assert.equal(first.pack.id, PACK.id);
    assert.equal(first.customerId, 'cus_test123');

    // The second attempt must find one already pending and decline to start
    // another. This is the whole safety property.
    const second = await AR.claimRecharge(ws.workspaceId);
    assert.equal(second, null, 'a second claim while one is pending must be refused');
  });

  /**
   * The realistic failure: two workers polling at the same instant. The unique
   * index is what decides, not the check before it.
   */
  test('concurrent claims produce exactly one charge', async () => {
    const ws = await ready({ balance: 0 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => AR.claimRecharge(ws.workspaceId)));
    const won = results.filter((r) => r !== null);
    assert.equal(won.length, 1, `${won.length} concurrent claims succeeded; exactly 1 may`);

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM credit_recharges WHERE workspace_id = $1', [ws.workspaceId]);
    assert.equal(Number(rows[0]!.n), 1, 'more than one recharge row exists for one shortfall');
  });

  test('a balance above the threshold claims nothing', async () => {
    const ws = await ready({ balance: THRESHOLD + 1 });
    assert.equal(await AR.claimRecharge(ws.workspaceId), null);
  });

  test('disabled means disabled, however low the balance', async () => {
    const ws = await ready({ balance: 0, enabled: false });
    assert.equal(await AR.claimRecharge(ws.workspaceId), null);
  });

  test('no card on file means no charge', async () => {
    const ws = await ready({ balance: 0, card: false });
    assert.equal(await AR.claimRecharge(ws.workspaceId), null,
      'we must never attempt a charge without a payment method already stored');
  });

  /**
   * Surge containment, pointed at ourselves. A runaway spend loop must drain an
   * allowance, not a bank account.
   */
  test('the daily cap holds even when every charge succeeds', async () => {
    const ws = await ready({ balance: 0 });
    for (let i = 0; i < AR.MAX_RECHARGES_PER_DAY; i++) {
      const c = await AR.claimRecharge(ws.workspaceId);
      assert.ok(c, `claim ${i + 1} of ${AR.MAX_RECHARGES_PER_DAY} should be allowed`);
      await AR.settle(c.row.id, { ok: true, paymentIntentId: `pi_${i}` });
    }
    assert.equal(await AR.claimRecharge(ws.workspaceId), null,
      `a ${AR.MAX_RECHARGES_PER_DAY + 1}th charge in a day must be refused`);
  });
});

describe('when a card fails', () => {
  test('a failure switches it off and records why', async () => {
    const ws = await ready({ balance: 0 });
    const c = await AR.claimRecharge(ws.workspaceId);
    await AR.settle(c!.row.id, { ok: false, reason: 'Your card was declined.' });
    await AR.disable(ws.workspaceId, 'Automatic top-up was declined and has been switched off.');

    const { rows } = await getPool().query<{
      auto_recharge_enabled: boolean; auto_recharge_disabled_reason: string | null }>(
      `SELECT auto_recharge_enabled, auto_recharge_disabled_reason
         FROM workspaces WHERE id = $1`, [ws.workspaceId]);
    assert.equal(rows[0]!.auto_recharge_enabled, false, 'a decline must stop further attempts');
    assert.match(rows[0]!.auto_recharge_disabled_reason!, /declined/);

    // And it stays off — retrying a decline is how a card gets locked.
    assert.equal(await AR.claimRecharge(ws.workspaceId), null);
  });

  test('a failed attempt does not consume the sequence forever', async () => {
    const ws = await ready({ balance: 0 });
    const c = await AR.claimRecharge(ws.workspaceId);
    await AR.settle(c!.row.id, { ok: false, reason: 'temporary' });
    // Re-enable as an operator would after fixing the card.
    await getPool().query(
      'UPDATE workspaces SET auto_recharge_enabled = true WHERE id = $1', [ws.workspaceId]);
    const next = await AR.claimRecharge(ws.workspaceId);
    assert.ok(next, 'after a failure is settled, a later attempt may proceed');
    assert.notEqual(next.row.id, c!.row.id);
  });
});

describe('configuring it', () => {
  test('a threshold at or above the pack size is refused', async () => {
    const ws = await ready({ balance: 0, enabled: false });
    await assert.rejects(
      () => AR.configure(ws.workspaceId,
        { enabled: true, thresholdMicros: PACK.creditMicros, packId: PACK.id }),
      /below the pack size/,
      'a threshold above the pack size recharges forever until the cap stops it');
  });

  test('enabling without a card on file is refused, and says why', async () => {
    const ws = await ready({ balance: 0, card: false, enabled: false });
    await assert.rejects(
      () => AR.configure(ws.workspaceId,
        { enabled: true, thresholdMicros: THRESHOLD, packId: PACK.id }),
      /card already on file/);
  });

  test('turning it off clears the reason it was turned off', async () => {
    const ws = await ready({ balance: 0 });
    await AR.disable(ws.workspaceId, 'declined');
    const s = await AR.configure(ws.workspaceId, { enabled: false });
    assert.equal(s.enabled, false);
    assert.equal(s.disabledReason, null);
  });
});

describe('the default is off', () => {
  test('a brand new workspace never charges anybody', async () => {
    const ws = await freshWorkspace(false);
    const { rows } = await getPool().query<{
      auto_recharge_enabled: boolean; auto_recharge_threshold_micros: string | null }>(
      `SELECT auto_recharge_enabled, auto_recharge_threshold_micros
         FROM workspaces WHERE id = $1`, [ws.workspaceId]);
    assert.equal(rows[0]!.auto_recharge_enabled, false);
    assert.equal(rows[0]!.auto_recharge_threshold_micros, null);
    assert.equal(await AR.claimRecharge(ws.workspaceId), null);
  });
});
