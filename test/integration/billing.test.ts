// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool, setBalance, setPeriodDecisions, setPlan } from '../helpers.js';

const { beginEffect } = await import('../../src/domain/effects.js');
const { addCredit, listLedger, getBilling } = await import('../../src/domain/metering.js');
const { settleTestCheckout, packById, applyPaymentEvent } = await import('../../src/domain/billing.js');
const { withTx } = await import('../../src/db/pool.js');
const { PLANS } = await import('../../src/domain/plans.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(false); });
after(async () => { await closePool(); });

const begin = (key: string) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'meter.test', idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0,
});

describe('metering', () => {
  test('only a newly created effect is metered', async () => {
    const before = (await getBilling(getPool(), ws.workspaceId))!.periodDecisions;
    const a = await begin('m-1');
    assert.equal(a.billing.metered, true);
    for (let i = 0; i < 4; i++) {
      const dup = await begin('m-1');
      assert.equal(dup.billing.metered, false, 'a repeat call must never be metered');
    }
    const after = (await getBilling(getPool(), ws.workspaceId))!.periodDecisions;
    assert.equal(after - before, 1);
  });

  test('within the allowance nothing is charged to credit', async () => {
    const b0 = (await getBilling(getPool(), ws.workspaceId))!;
    await begin('m-2');
    const b1 = (await getBilling(getPool(), ws.workspaceId))!;
    assert.equal(b1.creditMicros, b0.creditMicros, 'included usage must not draw credit');
  });

  test('past the allowance, credit is drawn at the plan overage rate', async () => {
    await setPeriodDecisions(ws.workspaceId, PLANS.free.includedEffects);
    await setBalance(ws.workspaceId, 1_000_000);
    const before = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    await begin('m-overage-1');
    const after = (await getBilling(getPool(), ws.workspaceId))!.creditMicros;
    assert.equal(before - after, PLANS.free.overageMicrosPerEffect);
  });

  test('an overage charge writes exactly one immutable ledger row', async () => {
    await setPeriodDecisions(ws.workspaceId, PLANS.free.includedEffects);
    await setBalance(ws.workspaceId, 1_000_000);
    const a = await begin('m-overage-2');
    const ledger = await listLedger(getPool(), ws.workspaceId, 200);
    const mine = ledger.filter((e) => e.effectId === a.effectId && e.kind === 'metering');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.deltaMicros, -PLANS.free.overageMicrosPerEffect);
  });

  test('an exhausted balance refuses new effects rather than running up a debt', async () => {
    await setPeriodDecisions(ws.workspaceId, PLANS.free.includedEffects);
    await setBalance(ws.workspaceId, 0);
    await assert.rejects(() => begin('m-broke'), (e: any) => e.code === 'insufficient_credit');

    // Nothing may be half-created: the transaction must have rolled back whole.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM effects WHERE workspace_id=$1 AND idempotency_key='m-broke'`,
      [ws.workspaceId]);
    assert.equal(rows[0].n, 0, 'a refused effect must leave no row behind');
  });

  test('an exhausted balance still permits replaying an existing effect', async () => {
    await setPeriodDecisions(ws.workspaceId, 0);
    await setBalance(ws.workspaceId, 0);
    const a = await begin('m-existing');
    await setPeriodDecisions(ws.workspaceId, PLANS.free.includedEffects);
    const dup = await begin('m-existing');
    assert.equal(dup.effectId, a.effectId);
    assert.notEqual(dup.decision, 'denied',
      'duplicate suppression must keep working when the allowance runs out');
  });

  test('the billing period rolls over at a month boundary', async () => {
    await getPool().query(
      `UPDATE workspaces SET period_decisions = 4999,
              period_start = date_trunc('month', now()) - interval '2 months'
        WHERE id = $1`, [ws.workspaceId]);
    await setBalance(ws.workspaceId, 0);
    const r = await begin('m-rollover');
    assert.equal(r.decision, 'execute', 'a new month must reset the allowance');
    const b = (await getBilling(getPool(), ws.workspaceId))!;
    assert.equal(b.periodDecisions, 1);
  });
});

describe('credit ledger', () => {
  test('a top-up is idempotent on its dedupe key', async () => {
    await setBalance(ws.workspaceId, 0);
    const apply = () => withTx((tx) =>
      addCredit(tx, ws.workspaceId, 5_000_000, 'evt_same', { source: 'test' }));

    const first = await apply();
    assert.equal(first.applied, true);
    assert.equal(first.balanceMicros, 5_000_000);

    for (let i = 0; i < 3; i++) {
      const again = await apply();
      assert.equal(again.applied, false, 'a replayed event must not credit twice');
      assert.equal(again.balanceMicros, 5_000_000);
    }
  });

  test('concurrent replays of one payment event credit exactly once', async () => {
    await setBalance(ws.workspaceId, 0);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        applyPaymentEvent('evt_concurrent', 'test', ws.workspaceId, 3_000_000, {})));
    const applied = results.filter(
      (r) => r.status === 'fulfilled' && r.value.applied).length;
    assert.equal(applied, 1, `exactly one application expected, got ${applied}`);
    const b = (await getBilling(getPool(), ws.workspaceId))!;
    assert.equal(b.creditMicros, 3_000_000);
  });

  test('the ledger fully explains the balance', async () => {
    await setBalance(ws.workspaceId, 0);
    await getPool().query('DELETE FROM ledger_entries WHERE workspace_id = $1', [ws.workspaceId]);
    await withTx((tx) => addCredit(tx, ws.workspaceId, 2_000_000, 'k1'));
    await withTx((tx) => addCredit(tx, ws.workspaceId, 1_000_000, 'k2'));
    const entries = await listLedger(getPool(), ws.workspaceId, 200);
    const sum = entries.reduce((acc, e) => acc + e.deltaMicros, 0);
    const b = (await getBilling(getPool(), ws.workspaceId))!;
    assert.equal(sum, b.creditMicros);
    assert.equal(entries[0]!.balanceAfter, b.creditMicros);
  });
});

describe('test-mode checkout', () => {
  test('settling applies credit exactly once', async () => {
    await setBalance(ws.workspaceId, 0);
    const pack = packById('pack_25')!;
    const sid = `cs_test_${ws.workspaceId}_pack_25_1`;

    const a = await settleTestCheckout(ws.workspaceId, sid, pack);
    assert.equal(a.applied, true);
    assert.equal(a.balanceMicros, pack.creditMicros);

    const b = await settleTestCheckout(ws.workspaceId, sid, pack);
    assert.equal(b.applied, false, 'replaying a settlement must not double-credit');
    assert.equal(b.balanceMicros, pack.creditMicros);
  });

  test('purchased credit is actually spendable on overage', async () => {
    await setBalance(ws.workspaceId, 0);
    await setPeriodDecisions(ws.workspaceId, PLANS.free.includedEffects);
    await assert.rejects(() => begin('spend-1'), (e: any) => e.code === 'insufficient_credit');

    await settleTestCheckout(ws.workspaceId,
      `cs_test_${ws.workspaceId}_pack_25_2`, packById('pack_25')!);

    const r = await begin('spend-1');
    assert.equal(r.decision, 'execute', 'topped-up credit must unblock the meter');
  });
});

describe('plan entitlements', () => {
  test('a plan upgrade raises the included allowance', async () => {
    await setPlan(ws.workspaceId, 'pro');
    await setPeriodDecisions(ws.workspaceId, PLANS.free.includedEffects + 10);
    await setBalance(ws.workspaceId, 0);
    const r = await begin('plan-1');
    assert.equal(r.decision, 'execute',
      'usage past the free allowance must be included on a larger plan');
    assert.equal(r.billing.metered, true);
    await setPlan(ws.workspaceId, 'free');
  });
});
