// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Per-counterparty ceilings, and the ways round them.
 *
 * The gap this closes: twenty distinct $500 refunds to one bank account passed
 * every check in this system, because a ceiling could be scoped to a workspace,
 * a key or an effect type and none of those is a destination. A destination
 * lives in the payload, and Ratchet never stores payloads.
 *
 * The resolution is that counting does not require reading. Most of the tests
 * below are therefore about evasion rather than arithmetic: a declared dimension
 * is agent-supplied text that selects a ceiling, and CLAUDE.md §6 says such text
 * must never influence control flow. It is allowed here only because a
 * declaration can tighten and never loosen — which is a property, and properties
 * need tests.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { beginEffect, reportEffect, resolveEffect } = await import('../../src/domain/effects.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { createWorkspace, createApiKey } = await import('../../src/domain/auth.js');
const { blind, scopeForDimension, matches } = await import('../../src/lib/dimensions.js');

let ws: string, other: string, keyId: string, otherKeyId: string;
before(async () => {
  await setupDb();
  const a = await createWorkspace('dim', `dim-${Date.now()}@example.test`);
  const b = await createWorkspace('dim2', `dim2-${Date.now()}@example.test`);
  ws = a.workspaceId; other = b.workspaceId;
  keyId = a.key.id; otherKeyId = b.key.id;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM spend_windows WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM effects WHERE workspace_id = ANY($1)', [[ws, other]]);
});

let n = 0;
const begin = (o: {
  workspace?: string; keyId?: string; type?: string; key?: string;
  cost?: number; dimensions?: Record<string, unknown>;
}) => {
  n += 1;
  return beginEffect({
    workspaceId: o.workspace ?? ws,
    apiKeyId: o.keyId ?? keyId,
    apiKeyPrefix: 'test',
    keyDailyBudgetMicros: null,
    effectType: o.type ?? 'payment.refund',
    idempotencyKey: o.key ?? `k${n}`,
    // Keyed on the idempotency key, not on a counter: a retry sends the same
    // payload, or `idempotency_key_reuse` refuses it before any of this is
    // reached.
    payload: { of: o.key ?? `k${n}` },
    estimatedCostMicros: o.cost ?? 0,
    dimensions: o.dimensions,
  });
};

const limit = (limits: Record<string, { dailyMicros: number | null; dailyCount: number | null }>,
                required: string[] = []) =>
  upsertPolicy(getPool(), ws, {
    effectType: 'payment.refund', dimensionLimits: limits, requiredDimensions: required,
  });

describe('counting a destination without ever seeing it', () => {
  test('the raw value is never stored anywhere', async () => {
    await begin({ dimensions: { counterparty: 'acct_secret_12345' } });
    const { rows } = await getPool().query(
      `SELECT dimensions::text AS d, request_summary::text AS r, reserved_dimension_scopes::text AS s
         FROM effects WHERE workspace_id = $1`, [ws]);
    const all = JSON.stringify(rows);
    assert.equal(all.includes('acct_secret_12345'), false,
      'the identifier the caller sent must not appear in the row');
    assert.match(rows[0].d, /"counterparty":\s*"[0-9a-f]{32}"/);
  });

  test('the same account in two workspaces is two unrelated identifiers', () => {
    const a = blind(ws, { counterparty: 'acct_1' });
    const b = blind(other, { counterparty: 'acct_1' });
    assert.notEqual(a.counterparty, b.counterparty,
      'one tenant must not be able to recognise another tenant\'s counterparty');
  });

  test('an operator who knows the value can still confirm a match', async () => {
    await begin({ dimensions: { counterparty: 'acct_known' } });
    const { rows } = await getPool().query<{ dimensions: Record<string, string> }>(
      'SELECT dimensions FROM effects WHERE workspace_id = $1', [ws]);
    assert.equal(matches(ws, 'counterparty', 'acct_known', rows[0]!.dimensions.counterparty!), true);
    assert.equal(matches(ws, 'counterparty', 'acct_other', rows[0]!.dimensions.counterparty!), false);
  });
});

describe('the ceiling that was missing', () => {
  test('twenty distinct $500 refunds to one account no longer pass', async () => {
    await limit({ counterparty: { dailyMicros: 2_000_000_000, dailyCount: null } });   // $2,000
    const dims = { counterparty: 'acct_victim' };

    for (let i = 0; i < 4; i += 1) {
      const r = await begin({ key: `ok-${i}`, cost: 500_000_000, dimensions: dims });
      assert.equal(r.decision, 'execute', `refund ${i} should have been allowed`);
    }
    await assert.rejects(
      () => begin({ key: 'over', cost: 500_000_000, dimensions: dims }),
      (e: { code?: string }) => e.code === 'budget_exceeded',
      'the fifth $500 refund to the same account is $2,500 and must be refused');
  });

  test('a different counterparty is a different bucket', async () => {
    await limit({ counterparty: { dailyMicros: 1_000_000_000, dailyCount: null } });
    await begin({ key: 'a', cost: 900_000_000, dimensions: { counterparty: 'acct_a' } });
    const r = await begin({ key: 'b', cost: 900_000_000, dimensions: { counterparty: 'acct_b' } });
    assert.equal(r.decision, 'execute', 'a ceiling is per destination, not a shared pot');
  });

  test('velocity applies to effects that cost nothing at all', async () => {
    await upsertPolicy(getPool(), ws, {
      effectType: 'email.send', dimensionLimits: { recipient: { dailyMicros: null, dailyCount: 3 } },
    });
    const dims = { recipient: 'someone@example.test' };
    for (let i = 0; i < 3; i += 1) {
      const r = await begin({ type: 'email.send', key: `m-${i}`, dimensions: dims });
      assert.equal(r.decision, 'execute');
    }
    await assert.rejects(
      () => begin({ type: 'email.send', key: 'm-4', dimensions: dims }),
      (e: { code?: string }) => e.code === 'budget_exceeded',
      'outbound messaging is exactly the case with no money to count');
  });

  test('a velocity refusal says it is about count, not money', async () => {
    await limit({ counterparty: { dailyMicros: null, dailyCount: 1 } });
    await begin({ key: 'one', dimensions: { counterparty: 'acct_v' } });
    await assert.rejects(
      () => begin({ key: 'two', dimensions: { counterparty: 'acct_v' } }),
      (e: { detail?: Record<string, unknown> }) => {
        assert.equal(e.detail?.countLimit, 1,
          'a caller told "budget exceeded" having spent nothing goes looking for money');
        assert.equal(e.detail?.countUsed, 1);
        return true;
      });
  });
});

describe('the ways round it', () => {
  /**
   * The evasion that makes the whole thing pointless if it works: stop
   * declaring, and every effect lands in no bucket.
   */
  test('omitting a required dimension is refused, not ignored', async () => {
    await limit({ counterparty: { dailyMicros: 1_000, dailyCount: null } }, ['counterparty']);
    await assert.rejects(
      () => begin({ key: 'nodim', cost: 5_000_000_000 }),
      (e: { code?: string; status?: number }) => e.code === 'dimension_required' && e.status === 400);
  });

  test('the refusal names the dimension, because a caller cannot guess', async () => {
    await limit({}, ['counterparty', 'channel']);
    await assert.rejects(
      () => begin({ key: 'partial', dimensions: { counterparty: 'a' } }),
      (e: { message?: string }) => /"channel"/.test(e.message ?? ''));
  });

  /**
   * A caller who lies lands in a different bucket. What must remain true is that
   * lying buys nothing that was not already permitted — the ceilings that do not
   * depend on a declaration still apply.
   */
  test('lying about the counterparty does not lift the effect-type ceiling', async () => {
    await upsertPolicy(getPool(), ws, {
      effectType: 'payment.refund',
      dailyBudgetMicros: 1_000_000_000,
      dimensionLimits: { counterparty: { dailyMicros: 900_000_000, dailyCount: null } },
    });
    await begin({ key: 'l1', cost: 600_000_000, dimensions: { counterparty: 'real' } });
    await assert.rejects(
      () => begin({ key: 'l2', cost: 600_000_000, dimensions: { counterparty: 'invented' } }),
      (e: { code?: string }) => e.code === 'budget_exceeded',
      'a fresh bucket must not be a fresh allowance');
  });

  test('declaring a dimension can only tighten, never loosen', async () => {
    await upsertPolicy(getPool(), ws, {
      effectType: 'payment.refund', dailyBudgetMicros: 100_000_000,
      dimensionLimits: { counterparty: { dailyMicros: 9_000_000_000, dailyCount: null } },
    });
    await assert.rejects(
      () => begin({ key: 'loose', cost: 500_000_000, dimensions: { counterparty: 'x' } }),
      (e: { code?: string }) => e.code === 'budget_exceeded',
      'a generous dimension limit must not override a tighter type limit');
  });

  test('a retry cannot move an effect into a fresh bucket', async () => {
    await limit({ counterparty: { dailyMicros: null, dailyCount: 1 } });
    const first = await begin({ key: 'retry', dimensions: { counterparty: 'acct_first' } });
    assert.equal(first.decision, 'execute');
    await reportEffect({
      workspaceId: ws, effectId: first.effectId, apiKeyId: keyId, apiKeyPrefix: 'test',
      leaseToken: first.leaseToken!, outcome: 'failed', failureReason: 'vendor down',
    });

    // Same idempotency key, different declared counterparty: the effect must be
    // counted where it was created, not where the retry claims it belongs.
    const again = await begin({ key: 'retry', dimensions: { counterparty: 'acct_second' } });
    assert.equal(again.decision, 'execute', 'a failed effect may be retried');
    const { rows } = await getPool().query<{ scope: string; used_count: number }>(
      `SELECT scope, used_count FROM spend_windows
        WHERE workspace_id = $1 AND scope LIKE 'dim:%'`, [ws]);
    assert.equal(rows.length, 1, `the retry opened a second bucket: ${JSON.stringify(rows)}`);
    assert.equal(rows[0]!.scope, scopeForDimension('counterparty', blind(ws, { counterparty: 'acct_first' }).counterparty!));
  });

  test('three attempts at one payment is one payment against a velocity ceiling', async () => {
    await limit({ counterparty: { dailyMicros: null, dailyCount: 2 } });
    const dims = { counterparty: 'acct_flap' };
    let r = await begin({ key: 'flap', dimensions: dims });
    for (let i = 0; i < 2; i += 1) {
      await reportEffect({
        workspaceId: ws, effectId: r.effectId, apiKeyId: keyId, apiKeyPrefix: 'test',
        leaseToken: r.leaseToken!, outcome: 'failed', failureReason: 'again',
      });
      r = await begin({ key: 'flap', dimensions: dims });
      assert.equal(r.decision, 'execute', `attempt ${i + 2} should not be refused`);
    }
    // One more DISTINCT payment is the second, and still fits.
    const second = await begin({ key: 'flap2', dimensions: dims });
    assert.equal(second.decision, 'execute');
    await assert.rejects(
      () => begin({ key: 'flap3', dimensions: dims }),
      (e: { code?: string }) => e.code === 'budget_exceeded',
      'the ceiling counts payments, and the third payment is over it');
  });

  test('cancelling does not hand the velocity allowance back', async () => {
    await limit({ counterparty: { dailyMicros: null, dailyCount: 1 } });
    const r = await begin({ key: 'c1', cost: 1_000, dimensions: { counterparty: 'acct_c' } });
    await getPool().query(
      `UPDATE effects SET state='indeterminate', lease_token=NULL,
              lease_expires_at = now() - interval '1 minute' WHERE id=$1`, [r.effectId]);
    await resolveEffect({
      workspaceId: ws, effectId: r.effectId, actor: 'operator', outcome: 'cancelled',
    });
    await assert.rejects(
      () => begin({ key: 'c2', dimensions: { counterparty: 'acct_c' } }),
      (e: { code?: string }) => e.code === 'budget_exceeded',
      'otherwise cancelling is the way round the ceiling');
  });
});

describe('money is counted as spent, not as estimated', () => {
  test('an under-declared cost is corrected in the counterparty bucket', async () => {
    await limit({ counterparty: { dailyMicros: 1_000_000_000, dailyCount: null } });
    const dims = { counterparty: 'acct_under' };
    const r = await begin({ key: 'u1', cost: 10_000_000, dimensions: dims });
    await reportEffect({
      workspaceId: ws, effectId: r.effectId, apiKeyId: keyId, apiKeyPrefix: 'test',
      leaseToken: r.leaseToken!, outcome: 'succeeded', actualCostMicros: 950_000_000,
    });
    await assert.rejects(
      () => begin({ key: 'u2', cost: 100_000_000, dimensions: dims }),
      (e: { code?: string }) => e.code === 'budget_exceeded',
      'a ceiling that counts estimates is walked past by under-declaring');
  });
});

describe('validation', () => {
  test('a dimension value must be a string a caller could plausibly mean', async () => {
    for (const bad of [{ counterparty: 123 }, { counterparty: '' }, { counterparty: 'x'.repeat(257) }]) {
      await assert.rejects(() => begin({ key: `bad-${Math.random()}`, dimensions: bad as never }),
        (e: { status?: number }) => e.status === 400, JSON.stringify(bad));
    }
  });

  test('names are constrained, because they become part of a scope key', async () => {
    await assert.rejects(() => begin({ key: 'n1', dimensions: { 'Counter Party': 'x' } }),
      (e: { status?: number }) => e.status === 400);
  });

  test('there is a ceiling on the number of ceilings', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 9; i += 1) many[`d${i}`] = 'v';
    await assert.rejects(() => begin({ key: 'n2', dimensions: many }),
      (e: { status?: number }) => e.status === 400);
  });

  test('declaring nothing is still the normal case and costs nothing', async () => {
    const r = await begin({ key: 'plain' });
    assert.equal(r.decision, 'execute');
    const { rows } = await getPool().query(
      "SELECT 1 FROM spend_windows WHERE workspace_id = $1 AND scope LIKE 'dim:%'", [ws]);
    assert.equal(rows.length, 0, 'no dimension declared, no dimension bookkeeping');
  });
});

describe('tenant isolation', () => {
  test('one workspace cannot spend another workspace\'s counterparty allowance', async () => {
    await limit({ counterparty: { dailyMicros: null, dailyCount: 1 } });
    await begin({ key: 'mine', dimensions: { counterparty: 'shared_acct' } });
    // The same real account, from the other workspace: a different MAC, a
    // different bucket, and no ceiling of ours applies to them.
    const theirs = await begin({
      workspace: other, keyId: otherKeyId, key: 'theirs',
      dimensions: { counterparty: 'shared_acct' },
    });
    assert.equal(theirs.decision, 'execute');
  });
});
