/**
 * Bunching under a threshold.
 *
 * The hard part of this feature is not finding structuring — it is not crying
 * wolf. A cap produces bunching honestly: told they may spend up to $10,000,
 * people spend $9,999. Most of what follows is about restraint, because a
 * detector that fires on ordinary behaviour is one an operator learns to ignore,
 * and then it is worse than nothing.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { structuringReport, _internals } = await import('../../src/domain/structuring.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { createWorkspace } = await import('../../src/domain/auth.js');
const { blind } = await import('../../src/lib/dimensions.js');

const T = 10_000_000_000;          // $10,000 in micro-USD
const $ = (dollars: number) => Math.round(dollars * 1_000_000);

let ws: string, other: string;
before(async () => {
  await setupDb();
  ws = (await createWorkspace('st', `st-${Date.now()}@example.test`)).workspaceId;
  other = (await createWorkspace('st2', `st2-${Date.now()}@example.test`)).workspaceId;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM effects WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM effect_policies WHERE workspace_id = ANY($1)', [[ws, other]]);
});

let n = 0;
/** Effects are seeded directly: what is under test is the arithmetic over amounts. */
async function amounts(
  values: number[],
  o: { workspace?: string; type?: string; counterparty?: string; ageDays?: number } = {},
) {
  for (const v of values) {
    n += 1;
    const dims = o.counterparty
      ? blind(o.workspace ?? ws, { counterparty: o.counterparty }) : {};
    await getPool().query(
      `INSERT INTO effects
         (id, workspace_id, effect_type, idempotency_key, fingerprint, state,
          declared_micros, actual_micros, dimensions, created_at, expires_at)
       VALUES ($1,$2,$3,$4,decode($5,'hex'),'succeeded',$6,$6,$7,
               now() - make_interval(days => $8), now() + interval '30 days')`,
      [`eff_st${n}_${Date.now().toString(36)}`, o.workspace ?? ws, o.type ?? 'payment.payout',
       `k${n}-${Math.random()}`, String(n).padStart(64, '0'), v,
       JSON.stringify(dims), o.ageDays ?? 0]);
  }
}

const watch = (threshold: number | null, type = 'payment.payout', workspace = ws) =>
  upsertPolicy(getPool(), workspace, {
    effectType: type, structuringThresholdMicros: threshold,
  });

const report = (days = 30, workspace = ws) => structuringReport(getPool(), workspace, days);

describe('the shape it exists to find', () => {
  test('twenty-three payments pressed under a $10,000 line are reported', async () => {
    await watch(T);
    await amounts(Array(23).fill($(9_800)));      // the hug band
    await amounts([$(8_400), $(8_800)]);          // the control band

    const r = await report();
    assert.equal(r.findings.length, 1);
    const f = r.findings[0]!;
    assert.equal(f.effectType, 'payment.payout');
    assert.equal(f.justBelow, 23);
    assert.equal(f.control, 2);
    assert.equal(f.excessRatio, 11.5);
    assert.equal(f.severity, 'high');
    assert.match(f.detail, /\$10,000/);
    assert.match(f.detail, /somewhere to look|place to look/i,
      'the wording must not present this as a conclusion');
  });

  test('an empty control band is the strongest signal, not a divide by zero', async () => {
    await watch(T);
    await amounts(Array(15).fill($(9_950)));
    const f = (await report()).findings[0]!;
    assert.equal(f.control, 0);
    assert.equal(f.excessRatio, 15, 'the control band is floored at one, never zero');
    assert.equal(Number.isFinite(f.excessRatio), true);
  });

  test('it says which line it measured against', async () => {
    await watch(T);
    await amounts(Array(12).fill($(9_500)));
    assert.equal((await report()).findings[0]!.thresholdSource, 'structuring_threshold');

    // No watch line, but an enforced ceiling — that is a line worth hugging too.
    await getPool().query('DELETE FROM effect_policies WHERE workspace_id = $1', [ws]);
    await upsertPolicy(getPool(), ws, { effectType: 'payment.payout', maxCostMicros: T });
    assert.equal((await report()).findings[0]!.thresholdSource, 'max_cost');
  });
});

describe('restraint', () => {
  test('amounts spread naturally below the line report nothing', async () => {
    await watch(T);
    // A decreasing tail, which is what real payment sizes look like.
    await amounts([...Array(20).fill($(2_000)), ...Array(10).fill($(5_000)),
                   ...Array(6).fill($(8_500)), ...Array(4).fill($(9_400))]);
    assert.deepEqual((await report()).findings, [],
      'ordinary amounts must not trip this, or an operator stops reading it');
  });

  test('a handful just below the line is not a pattern', async () => {
    await watch(T);
    await amounts(Array(9).fill($(9_900)));
    const r = await report();
    assert.deepEqual(r.findings, [], 'nine is below the floor and nine is not a distribution');
    assert.equal(r.examinedTypes[0]!.justBelow, 9,
      'though the count is still reported, so the operator can see it approaching');
  });

  test('bunching that is merely twice the control band is not reported', async () => {
    await watch(T);
    await amounts(Array(14).fill($(9_600)));
    await amounts(Array(7).fill($(8_600)));
    const r = await report();
    assert.equal(r.examinedTypes[0]!.justBelow, 14);
    assert.deepEqual(r.findings, [], '2x is a lumpy distribution, not a signal');
  });

  test('an effect type with no line is named, not silently skipped', async () => {
    await upsertPolicy(getPool(), ws, { effectType: 'email.send' });
    await amounts(Array(30).fill($(9_900)), { type: 'email.send' });
    const r = await report();
    assert.deepEqual(r.withoutThreshold, ['email.send']);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.examinedTypes, [],
      'nothing found and nothing configured must not look the same');
  });

  test('effects that declared no amount are not counted as zero', async () => {
    await watch(T);
    await amounts(Array(12).fill($(9_800)));
    await amounts(Array(50).fill(0));            // pre-migration rows, and free effects
    const r = await report();
    assert.equal(r.examinedTypes[0]!.examined, 12,
      'an effect with no declared amount tells you nothing about where amounts cluster');
  });

  test('the window is respected', async () => {
    await watch(T);
    await amounts(Array(20).fill($(9_800)), { ageDays: 60 });
    assert.deepEqual((await report(30)).findings, []);
    assert.equal((await report(90)).findings.length, 1);
  });
});

describe('where the bunching sits', () => {
  test('it names the blinded counterparty it concentrates on', async () => {
    await watch(T);
    await amounts(Array(14).fill($(9_800)), { counterparty: 'acct_suspect' });
    await amounts(Array(2).fill($(9_700)), { counterparty: 'acct_ordinary' });

    const f = (await report()).findings[0]!;
    const top = f.concentratedIn[0]!;
    assert.equal(top.dimension, 'counterparty');
    assert.equal(top.count, 14);
    assert.equal(top.blinded, blind(ws, { counterparty: 'acct_suspect' }).counterparty);
    assert.equal(top.blinded.length, 32, 'and it is still only a hash');
  });

  test('the account number never appears in the report', async () => {
    await watch(T);
    await amounts(Array(15).fill($(9_800)), { counterparty: 'acct_9999888877776666' });
    const r = await report();
    assert.equal(JSON.stringify(r).includes('acct_9999888877776666'), false,
      'the analysis must not be the place the blinding leaks');
  });

  test('a single occurrence is not called a concentration', async () => {
    await watch(T);
    for (let i = 0; i < 12; i += 1) {
      await amounts([$(9_800)], { counterparty: `acct_${i}` });
    }
    const f = (await report()).findings[0]!;
    assert.deepEqual(f.concentratedIn, [],
      'twelve different destinations is a cap, and the report should not imply otherwise');
  });
});

describe('isolation', () => {
  test('one workspace cannot see another\'s amounts', async () => {
    await watch(T);
    await watch(T, 'payment.payout', other);
    await amounts(Array(20).fill($(9_800)), { workspace: other });

    assert.deepEqual((await report()).findings, [], 'these are not our effects');
    assert.equal((await report(30, other)).findings.length, 1);
  });

  test('the threshold is per workspace, not global', async () => {
    await watch(T);
    await amounts(Array(15).fill($(9_800)));
    const mine = await report();
    const theirs = await report(30, other);
    assert.equal(mine.findings.length, 1);
    assert.deepEqual(theirs.examinedTypes, [], 'the other workspace configured nothing');
  });
});

describe('the thresholds themselves', () => {
  test('the bands are adjacent and equal, or the comparison means nothing', () => {
    const { HUG_FROM, CONTROL_FROM } = _internals;
    assert.equal(1 - HUG_FROM, HUG_FROM - CONTROL_FROM,
      'comparing a wide band to a narrow one would manufacture an excess');
  });

  test('a watch line enforces nothing', async () => {
    await watch(T);
    // Far above the watch line, and no ceiling is configured: it must be allowed.
    const { beginEffect } = await import('../../src/domain/effects.js');
    const { createApiKey } = await import('../../src/domain/auth.js');
    const key = await createApiKey(getPool(), ws, 'k', ['effects:begin'], null);
    const r = await beginEffect({
      workspaceId: ws, apiKeyId: key.id, apiKeyPrefix: 'test', keyDailyBudgetMicros: null,
      effectType: 'payment.payout', idempotencyKey: `over-${Date.now()}`,
      payload: {}, estimatedCostMicros: T * 5,
    });
    assert.equal(r.decision, 'execute',
      'structuring_threshold_micros is an observation, and observing must never refuse');
  });
});
