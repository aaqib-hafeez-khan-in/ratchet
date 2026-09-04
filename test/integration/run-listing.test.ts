// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * The runs page.
 *
 * The design question this settles is which runs appear. Listing only the ones
 * with a wallet would be the same mistake as listing only effect types with a
 * reconciliation cadence: the row you opened the page to find — the job spending
 * steadily with nothing bounding it — is exactly the one a filtered list omits.
 *
 * The second question is what "spent" means when there is no wallet. The gate
 * counted nothing, so the only number available is the sum of what callers
 * declared. That is an estimate, not a ledger, and the two must not arrive
 * looking identical.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { listRuns, setRunBudget, reserveRunSpend } =
  await import('../../src/domain/run-budget.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

const $ = (d: number) => Math.round(d * 1_000_000);
let ws: string, other: string;

before(async () => {
  await setupDb();
  ws = (await createWorkspace('runs', `runs-${Date.now()}@example.test`)).workspaceId;
  other = (await createWorkspace('runs2', `runs2-${Date.now()}@example.test`)).workspaceId;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM effects WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM run_budgets WHERE workspace_id = ANY($1)', [[ws, other]]);
});

let n = 0;
async function effect(o: {
  run: string | null; cost?: number; agent?: string | null;
  workspace?: string; ageDays?: number;
}) {
  n += 1;
  await getPool().query(
    `INSERT INTO effects
       (id, workspace_id, effect_type, idempotency_key, fingerprint, state,
        declared_micros, agent_id, run_id, created_at, expires_at)
     VALUES ($1,$2,'payment.payout',$3,decode($4,'hex'),'succeeded',$5,$6,$7,
             now() - make_interval(days => $8), now() + interval '90 days')`,
    [`eff_run${n}_${Date.now().toString(36)}`, o.workspace ?? ws, `k${n}-${Math.random()}`,
     String(n).padStart(64, '0'), o.cost ?? 0,
     o.agent === undefined ? 'worker' : o.agent, o.run, o.ageDays ?? 0]);
}

const runs = (workspace = ws, days = 7) => listRuns(workspace, { days });
const find = async (id: string, workspace = ws) =>
  (await runs(workspace)).find((r) => r.runId === id);

describe('which runs appear', () => {
  test('a run with no ceiling is listed, which is the point', async () => {
    await effect({ run: 'loose', cost: $(400) });
    const r = await find('loose');
    assert.ok(r, 'the run spending with nothing bounding it is the row you came for');
    assert.equal(r.limitMicros, null);
    assert.equal(r.spentMicros, $(400));
    assert.equal(r.spendSource, 'declared');
    assert.equal(r.remainingMicros, null);
    assert.equal(r.exhausted, false, 'no ceiling cannot be exhausted');
  });

  test('a wallet opened but never spent against still shows', async () => {
    await setRunBudget(ws, 'dispatched', $(50));
    const r = await find('dispatched');
    assert.ok(r, 'somebody set a ceiling and needs to see that it took');
    assert.equal(r.limitMicros, $(50));
    assert.equal(r.spentMicros, 0);
    assert.equal(r.effects, 0);
  });

  test('a budgeted run reports what the gate actually counted', async () => {
    await setRunBudget(ws, 'capped', $(100));
    await getPool().query('BEGIN');
    const client = getPool();
    await client.query('COMMIT');
    // Spend through the real reservation path, not by writing the column.
    const tx = await getPool().connect();
    try {
      await tx.query('BEGIN');
      await reserveRunSpend(tx, ws, 'capped', $(30));
      await tx.query('COMMIT');
    } finally { tx.release(); }

    const r = await find('capped');
    assert.equal(r!.spentMicros, $(30));
    assert.equal(r!.spendSource, 'wallet');
    assert.equal(r!.remainingMicros, $(70));
  });

  test('declared spend is not conflated with counted spend', async () => {
    // Same money, two runs: one capped, one not. The numbers must be labelled
    // differently even when they happen to be equal.
    await setRunBudget(ws, 'capped', $(100));
    const tx = await getPool().connect();
    try {
      await tx.query('BEGIN');
      await reserveRunSpend(tx, ws, 'capped', $(25));
      await tx.query('COMMIT');
    } finally { tx.release(); }
    await effect({ run: 'uncapped', cost: $(25) });

    assert.equal((await find('capped'))!.spendSource, 'wallet');
    assert.equal((await find('uncapped'))!.spendSource, 'declared');
  });

  test('effects with no run id are not a run', async () => {
    await effect({ run: null, cost: $(9) });
    assert.deepEqual(await runs(), []);
  });

  test('the window is respected', async () => {
    await effect({ run: 'old', cost: $(5), ageDays: 30 });
    assert.equal(await find('old'), undefined);
    assert.ok((await listRuns(ws, { days: 90 })).some((r) => r.runId === 'old'));
  });
});

describe('what an operator reads off the row', () => {
  test('exhausted is reported once spend reaches the ceiling', async () => {
    await setRunBudget(ws, 'done', $(10));
    const tx = await getPool().connect();
    try {
      await tx.query('BEGIN');
      await reserveRunSpend(tx, ws, 'done', $(10));
      await tx.query('COMMIT');
    } finally { tx.release(); }
    const r = await find('done');
    assert.equal(r!.exhausted, true);
    assert.equal(r!.remainingMicros, 0);
  });

  test('lowering a ceiling below what is spent leaves nothing remaining', async () => {
    await setRunBudget(ws, 'trimmed', $(100));
    const tx = await getPool().connect();
    try {
      await tx.query('BEGIN');
      await reserveRunSpend(tx, ws, 'trimmed', $(80));
      await tx.query('COMMIT');
    } finally { tx.release(); }
    await setRunBudget(ws, 'trimmed', $(20));

    const r = await find('trimmed');
    assert.equal(r!.spentMicros, $(80), 'the money is gone; the number must not pretend otherwise');
    assert.equal(r!.remainingMicros, 0, 'and nothing further may be spent');
    assert.equal(r!.exhausted, true);
  });

  test('agents on the run are named, and bounded', async () => {
    for (const a of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await effect({ run: 'many', cost: $(1), agent: a });
    }
    const r = await find('many');
    assert.equal(r!.agentIds.length, 5, 'a cell is not a list of every agent that ever ran');
  });

  test('the busiest recent run sorts first', async () => {
    await effect({ run: 'stale', cost: $(1), ageDays: 5 });
    await effect({ run: 'fresh', cost: $(1), ageDays: 0 });
    assert.equal((await runs())[0]!.runId, 'fresh');
  });
});

describe('a ceiling opened part-way through a run', () => {
  test('the wallet starts at zero, and the earlier spend is still reported', async () => {
    // $405 declared with nothing bounding it, then somebody sets a ceiling.
    await effect({ run: 'late', cost: $(405) });
    await setRunBudget(ws, 'late', $(250));

    const r = await find('late');
    assert.equal(r!.spentMicros, 0,
      'the wallet did not gate those effects, so its ledger honestly starts at zero');
    assert.equal(r!.declaredMicros, $(405),
      'but reporting only the zero would read as "plenty of room" on a run that has '
      + 'already spent four hundred dollars, which is the one direction this must not reassure');
    assert.equal(r!.remainingMicros, $(250));
  });

  test('a wallet opened first has nothing hidden behind it', async () => {
    await setRunBudget(ws, 'early', $(100));
    await effect({ run: 'early', cost: $(30) });
    const tx = await getPool().connect();
    try {
      await tx.query('BEGIN');
      await reserveRunSpend(tx, ws, 'early', $(30));
      await tx.query('COMMIT');
    } finally { tx.release(); }

    const r = await find('early');
    assert.equal(r!.spentMicros, $(30));
    assert.equal(r!.declaredMicros, $(30),
      'declared and counted agree, so the console shows no "before" note');
  });

  test('an unbudgeted run reports the same number twice, not two different ones', async () => {
    await effect({ run: 'plain', cost: $(70) });
    const r = await find('plain');
    assert.equal(r!.spentMicros, $(70));
    assert.equal(r!.declaredMicros, $(70));
  });
});

describe('isolation', () => {
  test('one workspace never sees another\'s runs', async () => {
    await effect({ run: 'theirs', cost: $(50), workspace: other });
    await setRunBudget(other, 'their-wallet', $(10));
    assert.deepEqual(await runs(), []);
    assert.equal((await runs(other)).length, 2);
  });

  test('the same run id in two workspaces is two runs', async () => {
    await setRunBudget(ws, 'shared-name', $(10));
    await setRunBudget(other, 'shared-name', $(999));
    assert.equal((await find('shared-name'))!.limitMicros, $(10));
    assert.equal((await find('shared-name', other))!.limitMicros, $(999));
  });
});
