// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Fan-out and fan-in.
 *
 * The failure mode this feature has to avoid is flagging payroll. Reaching five
 * hundred counterparties is not a signal — a disbursement run does it every
 * month and is the healthiest thing in the system. What makes it a signal is
 * that the counterparties are NEW. So most of what follows checks that ordinary
 * repeated work stays silent, and that the same shape lights up the moment the
 * destinations are ones nobody has paid before.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { fanReport, _internals } = await import('../../src/domain/fan.js');
const { createWorkspace } = await import('../../src/domain/auth.js');
const { blind } = await import('../../src/lib/dimensions.js');

let ws: string, other: string;
before(async () => {
  await setupDb();
  ws = (await createWorkspace('fan', `fan-${Date.now()}@example.test`)).workspaceId;
  other = (await createWorkspace('fan2', `fan2-${Date.now()}@example.test`)).workspaceId;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM effects WHERE workspace_id = ANY($1)', [[ws, other]]);
});

let n = 0;
/** One effect per counterparty, blinded exactly as the real path blinds them. */
async function paid(counterparties: string[], o: {
  workspace?: string; run?: string | null; agent?: string | null; ageDays?: number;
} = {}) {
  const w = o.workspace ?? ws;
  for (const cp of counterparties) {
    n += 1;
    await getPool().query(
      `INSERT INTO effects
         (id, workspace_id, effect_type, idempotency_key, fingerprint, state,
          agent_id, run_id, dimensions, created_at, expires_at)
       VALUES ($1,$2,'payment.payout',$3,decode($4,'hex'),'succeeded',$5,$6,$7,
               now() - make_interval(days => $8), now() + interval '400 days')`,
      [`eff_fan${n}_${Date.now().toString(36)}`, w, `k${n}-${Math.random()}`,
       String(n).padStart(64, '0'),
       o.agent === undefined ? 'payer' : o.agent,
       o.run === undefined ? 'run-1' : o.run,
       JSON.stringify(blind(w, { counterparty: cp })), o.ageDays ?? 0]);
  }
}

const people = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}_${i}`);

const report = (days = 30, workspace = ws, dimension = 'counterparty') =>
  fanReport(getPool(), workspace, dimension, days);

describe('fan-out is about novelty, not width', () => {
  test('payroll paying the same five hundred people every month is silent', async () => {
    const staff = people('staff', 40);
    await paid(staff, { ageDays: 60, run: 'run-may' });      // paid before
    await paid(staff, { ageDays: 30, run: 'run-june' });
    await paid(staff, { ageDays: 1, run: 'run-july' });

    const r = await report();
    assert.deepEqual(r.fanOut, [],
      'a run that pays people it has paid before is the healthiest thing in the system');
    assert.equal(r.counterpartiesInWindow, 40, 'though the spread is still reported');
  });

  test('the same width to brand-new accounts is reported', async () => {
    await paid(people('staff', 40), { ageDays: 60, run: 'run-history' });
    await paid(people('mule', 40), { ageDays: 1, run: 'run-suspect' });

    const r = await report();
    const f = r.fanOut.find((x) => x.id === 'run-suspect');
    assert.ok(f, 'forty destinations nobody has ever paid is the shape this exists for');
    assert.equal(f.distinctCounterparties, 40);
    assert.equal(f.firstSeen, 40);
    assert.equal(f.newShare, 1);
    assert.equal(f.severity, 'high');
    assert.match(f.detail, /question rather than an answer/i,
      'a first run of anything looks the same, and the wording has to say so');
  });

  test('a run mostly repeating itself is silent even with some new names', async () => {
    const staff = people('staff', 40);
    await paid(staff, { ageDays: 60, run: 'run-old' });
    // Same 40 plus 5 new joiners: 11% new, which is a hiring month.
    await paid([...staff, ...people('joiner', 5)], { ageDays: 1, run: 'run-new' });
    assert.deepEqual((await report()).fanOut, []);
  });

  test('a narrow spread is not fan-out however new it is', async () => {
    await paid(people('fresh', 19), { ageDays: 1, run: 'run-small' });
    assert.deepEqual((await report()).fanOut, [],
      'nineteen destinations is a working day, not a network');
  });

  test('it reports by agent as well as by run', async () => {
    await paid(people('new', 30), { ageDays: 1, run: 'r1', agent: 'disburser' });
    const r = await report();
    assert.ok(r.fanOut.some((f) => f.grouping === 'run' && f.id === 'r1'));
    assert.ok(r.fanOut.some((f) => f.grouping === 'agent' && f.id === 'disburser'),
      'a caller that sends no run_id must still be visible');
  });

  test('effects with no run and no agent are simply not grouped', async () => {
    await paid(people('anon', 30), { ageDays: 1, run: null, agent: null });
    assert.deepEqual((await report()).fanOut, []);
  });
});

describe('what counts as seen before', () => {
  test('a counterparty from beyond the lookback is new again', async () => {
    const { PRIOR_WINDOWS } = _internals;
    const old = people('ancient', 30);
    // Older than window * PRIOR_WINDOWS, so outside what "seen before" looks at.
    await paid(old, { ageDays: 30 * PRIOR_WINDOWS + 20, run: 'run-ancient' });
    await paid(old, { ageDays: 1, run: 'run-today' });

    const f = (await report(30)).fanOut.find((x) => x.id === 'run-today');
    assert.ok(f, 'a destination last paid long ago is, for this question, new');
    assert.equal(f.firstSeen, 30);
  });

  test('a counterparty inside the lookback is not new', async () => {
    const known = people('known', 30);
    await paid(known, { ageDays: 45, run: 'run-before' });
    await paid(known, { ageDays: 1, run: 'run-after' });
    assert.deepEqual((await report(30)).fanOut, []);
  });
});

describe('fan-in: what no per-agent limit can see', () => {
  test('one counterparty collecting from several agents is reported', async () => {
    for (const agent of ['refunder', 'payouts', 'ops-bot']) {
      await paid(['acct_collector'], { agent, run: `r-${agent}` });
    }
    const r = await report();
    assert.equal(r.fanIn.length, 1);
    const f = r.fanIn[0]!;
    assert.equal(f.distinctAgents, 3);
    assert.equal(f.blinded, blind(ws, { counterparty: 'acct_collector' }).counterparty);
    assert.match(f.detail, /no per-agent ceiling can see across agents/i);
  });

  test('two agents is not yet a pattern', async () => {
    for (const agent of ['refunder', 'payouts']) {
      await paid(['acct_shared'], { agent });
    }
    assert.deepEqual((await report()).fanIn, [], 'a handoff between two agents is ordinary');
  });

  test('one busy agent is not fan-in however many times it pays', async () => {
    await paid(Array(50).fill('acct_supplier'), { agent: 'payouts' });
    assert.deepEqual((await report()).fanIn, [],
      'fan-in is about how many DIFFERENT agents converge, not volume');
  });

  test('the counterparty is named only as a hash', async () => {
    for (const agent of ['a', 'b', 'c']) await paid(['acct_9999888877776666'], { agent });
    const r = await report();
    assert.equal(JSON.stringify(r).includes('acct_9999888877776666'), false);
    assert.match(r.fanIn[0]!.blinded, /^[0-9a-f]{32}$/);
  });
});

describe('isolation', () => {
  test('one workspace never sees another\'s spread', async () => {
    await paid(people('theirs', 40), { workspace: other, ageDays: 1, run: 'their-run' });
    const mine = await report();
    assert.deepEqual(mine.fanOut, []);
    assert.equal(mine.counterpartiesInWindow, 0);
    assert.equal((await report(30, other)).fanOut.length >= 1, true);
  });

  test('the same real account in two workspaces is two different counterparties', async () => {
    for (const agent of ['a', 'b', 'c']) await paid(['acct_same'], { agent });
    for (const agent of ['a', 'b', 'c']) await paid(['acct_same'], { agent, workspace: other });
    const mine = (await report()).fanIn[0]!;
    const theirs = (await report(30, other)).fanIn[0]!;
    assert.notEqual(mine.blinded, theirs.blinded,
      'cross-tenant correlation must be impossible even here');
  });
});

describe('other dimensions', () => {
  test('it counts across whichever dimension is asked for', async () => {
    n += 1;
    for (let i = 0; i < 25; i += 1) {
      n += 1;
      await getPool().query(
        `INSERT INTO effects
           (id, workspace_id, effect_type, idempotency_key, fingerprint, state,
            agent_id, run_id, dimensions, created_at, expires_at)
         VALUES ($1,$2,'sms.send',$3,decode($4,'hex'),'succeeded','texter','blast',$5,
                 now(), now() + interval '30 days')`,
        [`eff_dim${n}_${Date.now().toString(36)}`, ws, `k${n}-${Math.random()}`,
         String(n).padStart(64, '0'),
         JSON.stringify(blind(ws, { recipient: `+1555000${i}` }))]);
    }
    assert.deepEqual((await report(30, ws, 'counterparty')).fanOut, [],
      'nothing declared a counterparty');
    const byRecipient = await report(30, ws, 'recipient');
    assert.equal(byRecipient.counterpartiesInWindow, 25);
    assert.ok(byRecipient.fanOut.some((f) => f.id === 'blast'));
  });
});
