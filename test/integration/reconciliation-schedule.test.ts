// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Reconciliation on a cadence.
 *
 * The boundary this must not cross is the whole product: Ratchet has no vendor
 * credentials and no outbound access to a customer's systems, so "scheduled
 * reconciliation" cannot mean it goes and asks Stripe. What is scheduled is the
 * REMEMBERING. The gate is the only thing that knows how long it has been since
 * the last comparison, so it keeps the calendar and says when one is overdue; the
 * vendor's truth still arrives from the customer.
 *
 * The other thing under test is restraint. A reminder that fires every sweep
 * teaches an operator to mute the channel, and a muted reminder is worse than
 * none — so most of what follows is about NOT notifying.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { recordRun, reconciliationStatus, noticeOverdue } =
  await import('../../src/domain/reconciliation.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

const HOURS = 3_600_000;
let ws: string, other: string;

before(async () => {
  await setupDb();
  ws = (await createWorkspace('rec', `rec-${Date.now()}@example.test`)).workspaceId;
  other = (await createWorkspace('rec2', `rec2-${Date.now()}@example.test`)).workspaceId;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM reconciliation_runs WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM effect_policies WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM webhook_endpoints WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM webhook_deliveries WHERE workspace_id = ANY($1)', [[ws, other]]);
});

const cadence = (hours: number | null, o: { type?: string; workspace?: string } = {}) =>
  upsertPolicy(getPool(), o.workspace ?? ws, {
    effectType: o.type ?? 'payment.payout', reconcileEveryHours: hours,
  });

/** Pretend the policy was configured a while ago, so the grace period is past. */
const policySetHoursAgo = (h: number, o: { type?: string; workspace?: string } = {}) =>
  getPool().query(
    `UPDATE effect_policies SET updated_at = now() - make_interval(hours => $3)
      WHERE workspace_id = $1 AND effect_type = $2`,
    [o.workspace ?? ws, o.type ?? 'payment.payout', h]);

const ranHoursAgo = async (h: number, counts = { checked: 10, gated: 10, ungated: 0 },
                           o: { type?: string; workspace?: string } = {}) => {
  await recordRun(getPool(), o.workspace ?? ws, o.type ?? 'payment.payout', counts);
  await getPool().query(
    `UPDATE reconciliation_runs SET created_at = now() - make_interval(hours => $3)
      WHERE workspace_id = $1 AND effect_type = $2 AND created_at > now() - interval '1 minute'`,
    [o.workspace ?? ws, o.type ?? 'payment.payout', h]);
};

const subscribe = () => getPool().query(
  `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events)
   VALUES ($1,$2,'https://example.test/hook','whsec_test',$3)`,
  [`wh_rec_${Date.now()}_${Math.random().toString(36).slice(2)}`, ws, ['reconciliation.due']]);

const delivered = async () => {
  const { rows } = await getPool().query<{ payload: any }>(
    `SELECT payload FROM webhook_deliveries
      WHERE workspace_id=$1 AND event_type='reconciliation.due'
      ORDER BY created_at`, [ws]);
  return rows.map((r) => {
    const b = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    return b.data ?? b;
  });
};

describe('the gate keeps the calendar', () => {
  test('a type not reconciled within its cadence is announced', async () => {
    await subscribe();
    await cadence(24);
    await policySetHoursAgo(100);
    await ranHoursAgo(30);

    assert.equal(await noticeOverdue(), 1);
    const events = await delivered();
    assert.equal(events.length, 1);
    assert.equal(events[0].effectType, 'payment.payout');
    assert.equal(events[0].everyHours, 24);
    assert.ok(events[0].hoursSinceLastRun >= 29);
  });

  test('a type reconciled inside its cadence is left alone', async () => {
    await subscribe();
    await cadence(24);
    await policySetHoursAgo(100);
    await ranHoursAgo(2);
    assert.equal(await noticeOverdue(), 0);
    assert.deepEqual(await delivered(), []);
  });

  test('never reconciled at all is announced, and says so', async () => {
    await subscribe();
    await cadence(24);
    await policySetHoursAgo(100);
    assert.equal(await noticeOverdue(), 1);
    const [e] = await delivered();
    assert.equal(e.lastRunAt, null);
    assert.match(e.detail, /never been reconciled/i);
  });

  test('the wording never claims Ratchet will go and fetch anything', async () => {
    await subscribe();
    await cadence(24);
    await policySetHoursAgo(100);
    await ranHoursAgo(30);
    await noticeOverdue();
    const [e] = await delivered();
    assert.match(e.detail, /cannot fetch/i,
      'the boundary is the product; the notification must not blur it');
    assert.match(e.detail, /post them|POST \/v1\/reconcile/i,
      'and it has to say who does the fetching');
  });

  test('no cadence means no reminder, ever', async () => {
    await subscribe();
    await cadence(null);
    await policySetHoursAgo(1000);
    assert.equal(await noticeOverdue(), 0,
      'an unrequested reminder that starts nagging is how a feature gets hated');
  });
});

describe('restraint', () => {
  test('a cadence set moments ago does not fire on the next sweep', async () => {
    await subscribe();
    await cadence(1);
    // updated_at is now: inside the grace period, even though 1h has "elapsed"
    // against a history that predates the setting.
    await getPool().query(
      `UPDATE reconciliation_runs SET created_at = now() - interval '500 hours'
        WHERE workspace_id = $1`, [ws]);
    assert.equal(await noticeOverdue(), 0,
      'turning a reminder on must not immediately accuse you of being late');
  });

  test('it announces once per cadence, not once per sweep', async () => {
    await subscribe();
    await cadence(24);
    await policySetHoursAgo(100);
    await ranHoursAgo(30);

    assert.equal(await noticeOverdue(), 1);
    assert.equal(await noticeOverdue(), 0, 'the second sweep must stay quiet');
    assert.equal(await noticeOverdue(), 0);
    assert.equal((await delivered()).length, 1);
  });

  test('after a cadence passes with still no run, it speaks again', async () => {
    await subscribe();
    await cadence(24);
    await policySetHoursAgo(100);
    await ranHoursAgo(30);
    await noticeOverdue();

    // A full cadence later, still unreconciled: worth saying once more.
    await getPool().query(
      `UPDATE effect_policies SET reconcile_due_notified_at = now() - interval '25 hours'
        WHERE workspace_id = $1`, [ws]);
    assert.equal(await noticeOverdue(), 1);
    assert.equal((await delivered()).length, 2);
  });

  test('reconciling clears it without anyone touching the reminder', async () => {
    await subscribe();
    await cadence(24);
    await policySetHoursAgo(100);
    await ranHoursAgo(30);
    await noticeOverdue();

    await recordRun(getPool(), ws, 'payment.payout', { checked: 5, gated: 5, ungated: 0 });
    await getPool().query(
      `UPDATE effect_policies SET reconcile_due_notified_at = now() - interval '99 hours'
        WHERE workspace_id = $1`, [ws]);
    assert.equal(await noticeOverdue(), 0, 'doing the thing is what stops the reminder');
  });
});

describe('what the operator can see', () => {
  test('status reports coverage, lateness and the last counts', async () => {
    await cadence(24);
    await policySetHoursAgo(100);
    await ranHoursAgo(30, { checked: 120, gated: 118, ungated: 2 });

    const [s] = await reconciliationStatus(getPool(), ws);
    assert.equal(s!.effectType, 'payment.payout');
    assert.equal(s!.everyHours, 24);
    assert.equal(s!.overdue, true);
    assert.ok(s!.hoursSinceLastRun! >= 29);
    assert.deepEqual(s!.lastRun, { checked: 120, gated: 118, ungated: 2 });
  });

  test('a type with no cadence is still listed, which is the point', async () => {
    await cadence(null);
    const [s] = await reconciliationStatus(getPool(), ws);
    assert.equal(s!.everyHours, null);
    assert.equal(s!.lastRunAt, null);
    assert.equal(s!.overdue, false,
      'not overdue, because nothing was promised — but visible, because nothing was done');
  });

  test('the ungated trend is oldest first, so a rising line reads as one', async () => {
    await cadence(24);
    for (const [i, n] of [1, 3, 9].entries()) {
      await ranHoursAgo(10 - i * 3, { checked: 100, gated: 100 - n, ungated: n });
    }
    const [s] = await reconciliationStatus(getPool(), ws);
    assert.deepEqual(s!.ungatedTrend, [1, 3, 9]);
  });

  test('it keeps only the last ten runs in the trend', async () => {
    await cadence(24);
    for (let i = 0; i < 14; i += 1) {
      await ranHoursAgo(20 - i, { checked: 1, gated: 1, ungated: i });
    }
    const [s] = await reconciliationStatus(getPool(), ws);
    assert.equal(s!.ungatedTrend.length, 10);
    assert.equal(s!.ungatedTrend.at(-1), 13, 'and the newest is last');
  });
});

describe('isolation', () => {
  test('a sweep never announces one workspace\'s gap to another', async () => {
    await subscribe();                       // subscribed on ws only
    await cadence(24, { workspace: other });
    await policySetHoursAgo(100, { workspace: other });
    await noticeOverdue();
    assert.deepEqual(await delivered(), [],
      'their overdue check is not our webhook');
  });

  test('status is scoped to the workspace asking', async () => {
    await cadence(24, { workspace: other });
    await ranHoursAgo(1, { checked: 9, gated: 9, ungated: 0 }, { workspace: other });
    assert.deepEqual(await reconciliationStatus(getPool(), ws), []);
    assert.equal((await reconciliationStatus(getPool(), other)).length, 1);
  });
});

describe('the record itself', () => {
  test('a run stores counts and no keys', async () => {
    await recordRun(getPool(), ws, 'payment.payout',
      { checked: 3, gated: 2, ungated: 1 });
    const { rows } = await getPool().query(
      'SELECT * FROM reconciliation_runs WHERE workspace_id = $1', [ws]);
    const all = JSON.stringify(rows);
    assert.equal(rows.length, 1);
    assert.equal(/idempotency|key/i.test(Object.keys(rows[0]!).join(' ')), false,
      'the caller supplied the keys and gets the unmatched ones back live; '
      + 'a store of records about actions that bypassed the gate answers nothing extra');
    assert.equal(all.includes('"ungated":1') || all.includes('"ungated": 1')
      || Number(rows[0]!.ungated) === 1, true);
  });
});
