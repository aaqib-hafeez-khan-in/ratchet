// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * The behaviour `reserveSpend` must keep, whatever shape it takes internally.
 *
 * This is the code that enforces ceilings on a customer's money at third
 * parties. It is being rewritten for speed, so its contract is written down
 * first — these tests were green against the original implementation before a
 * line of it changed, which is the only way a refactor of something like this
 * is worth attempting.
 *
 * Three properties matter, and only one of them is "it refuses when over":
 *
 *   1. A refusal leaves NOTHING behind. A ceiling that counts the spend it just
 *      refused would ratchet a workspace shut over repeated refusals.
 *   2. All scopes are all-or-nothing. Passing the workspace ceiling and failing
 *      the key ceiling must not leave the workspace's counter incremented.
 *   3. Concurrent callers cannot collectively exceed a ceiling — including on
 *      the first spend of a day, when the row does not exist yet and a plain
 *      SELECT ... FOR UPDATE would lock nothing.
 */
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';

const B = await import('../../src/domain/budget.js');

after(async () => { await closePool(); });

const DAY = new Date('2026-09-02T12:00:00Z');
const KEY = 'key_test_1';
const TYPE = 'payment.refund';

const baseArgs = (workspaceId: string, amountMicros: number, limits: {
  ws?: number | null; key?: number | null; type?: number | null } = {}) => ({
  workspaceId, apiKeyId: KEY, effectType: TYPE, amountMicros,
  workspaceDailyBudgetMicros: limits.ws ?? null,
  keyDailyBudgetMicros: limits.key ?? null,
  typeDailyBudgetMicros: limits.type ?? null,
  now: DAY,
});

/** Run reserveSpend in its own transaction, exactly as begin() does. */
async function reserve(workspaceId: string, amount: number, limits = {}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await B.reserveSpend(client, baseArgs(workspaceId, amount, limits) as never);
    await client.query('COMMIT');
    return { ok: true as const };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false as const, err: err as Error };
  } finally { client.release(); }
}

const spentOn = async (workspaceId: string, scope: string) => {
  const { rows } = await getPool().query<{ spent_micros: string }>(
    'SELECT spent_micros FROM spend_windows WHERE workspace_id=$1 AND scope=$2',
    [workspaceId, scope]);
  return Number(rows[0]?.spent_micros ?? 0);
};

describe('reserving spend', () => {
  test('a reservation inside every ceiling is recorded against all three scopes', async () => {
    const ws = await freshWorkspace(false);
    const r = await reserve(ws.workspaceId, 500, { ws: 10_000, key: 10_000, type: 10_000 });
    assert.equal(r.ok, true);
    assert.equal(await spentOn(ws.workspaceId, B.SCOPE_WORKSPACE), 500);
    assert.equal(await spentOn(ws.workspaceId, B.scopeForKey(KEY)), 500);
    assert.equal(await spentOn(ws.workspaceId, B.scopeForType(TYPE)), 500);
  });

  test('zero is a no-op and writes nothing at all', async () => {
    const ws = await freshWorkspace(false);
    assert.equal((await reserve(ws.workspaceId, 0, { ws: 10 })).ok, true);
    const { rows } = await getPool().query(
      'SELECT 1 FROM spend_windows WHERE workspace_id=$1', [ws.workspaceId]);
    assert.equal(rows.length, 0, 'declaring no cost must not create a window row');
  });

  /**
   * The property that matters most. A ceiling that counted refused spend would
   * ratchet a workspace shut: refuse, count, refuse harder, forever.
   */
  test('a refusal records nothing', async () => {
    const ws = await freshWorkspace(false);
    await reserve(ws.workspaceId, 900, { ws: 1_000 });          // now at 900 of 1000
    const before = await spentOn(ws.workspaceId, B.SCOPE_WORKSPACE);

    const r = await reserve(ws.workspaceId, 500, { ws: 1_000 }); // would reach 1400
    assert.equal(r.ok, false, 'a reservation past the ceiling must be refused');
    assert.equal(r.err.name, 'BudgetExceeded');

    assert.equal(await spentOn(ws.workspaceId, B.SCOPE_WORKSPACE), before,
      'the refused amount was counted anyway — the ceiling would ratchet shut');
  });

  test('the error reports the spend BEFORE this reservation, not after', async () => {
    const ws = await freshWorkspace(false);
    await reserve(ws.workspaceId, 900, { ws: 1_000 });
    const r = await reserve(ws.workspaceId, 500, { ws: 1_000 });
    assert.equal(r.ok, false);
    const check = (r.err as unknown as { check: Record<string, unknown> }).check;
    assert.equal(check.spentMicros, 900,
      'spentMicros must be what was already spent, not the total including this attempt');
    assert.equal(check.requestedMicros, 500);
    assert.equal(check.limitMicros, 1_000);
    assert.equal(check.scope, B.SCOPE_WORKSPACE);
  });

  /**
   * Partial application would be the subtle bug: the workspace ceiling passes,
   * the key ceiling fails, and the workspace counter keeps the increment.
   */
  test('failing one scope leaves the others untouched', async () => {
    const ws = await freshWorkspace(false);
    const r = await reserve(ws.workspaceId, 500, { ws: 10_000, key: 100, type: 10_000 });
    assert.equal(r.ok, false, 'the key ceiling of 100 must refuse a 500 spend');
    for (const scope of [B.SCOPE_WORKSPACE, B.scopeForKey(KEY), B.scopeForType(TYPE)]) {
      assert.equal(await spentOn(ws.workspaceId, scope), 0,
        `${scope} was incremented despite the reservation being refused`);
    }
  });

  test('the scope that breached is the one named in the error', async () => {
    const ws = await freshWorkspace(false);
    const r = await reserve(ws.workspaceId, 500, { ws: 10_000, key: 10_000, type: 100 });
    assert.equal(r.ok, false);
    assert.equal((r.err as unknown as { check: { scope: string } }).check.scope,
      B.scopeForType(TYPE));
  });

  /**
   * The race the insert-then-lock ordering exists for. On the first spend of a
   * day the row does not exist, and `SELECT ... FOR UPDATE` locks nothing when
   * it matches nothing — so every concurrent caller would read 0 and every one
   * would pass.
   */
  test('concurrent reservations cannot collectively exceed the ceiling', async () => {
    const ws = await freshWorkspace(false);
    const LIMIT = 1_000, EACH = 200;              // at most 5 may succeed
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserve(ws.workspaceId, EACH, { ws: LIMIT })));

    const ok = results.filter((r) => r.ok).length;
    const total = await spentOn(ws.workspaceId, B.SCOPE_WORKSPACE);
    assert.ok(total <= LIMIT,
      `${ok} of 12 concurrent reservations succeeded, totalling ${total} against a ceiling of ${LIMIT}`);
    assert.equal(total, ok * EACH, 'recorded spend must equal what was actually allowed');
  });

  test('a null ceiling means unlimited, and is still counted', async () => {
    const ws = await freshWorkspace(false);
    assert.equal((await reserve(ws.workspaceId, 5_000_000)).ok, true);
    assert.equal(await spentOn(ws.workspaceId, B.SCOPE_WORKSPACE), 5_000_000,
      'spend must be recorded even with no ceiling, or a later ceiling starts from zero');
  });
});
