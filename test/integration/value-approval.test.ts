/**
 * Approval triggered by how much is at stake.
 *
 * `mode = 'require_approval'` was the only approval control there was, and it is
 * per effect type: every refund waits for a human, or none does. Nobody's rule
 * looks like that. The rule finance teams state in their first sentence is a
 * threshold — "anything over five thousand needs a second pair of eyes" — and
 * without one an operator chooses between reviewing three hundred trivial
 * refunds a day and reviewing none of them. Every real deployment chooses none,
 * which means the control that existed was, in practice, off.
 *
 * The delicate part is that this keys on a number the CALLER SENT, and CLAUDE.md
 * §6 says agent-supplied values must not influence control flow. It is allowed
 * here for the same reason dimensions are: the influence runs one way. A bigger
 * declared amount can only add friction, never remove it. Most of what follows
 * tests that direction rather than the arithmetic, because that is the property
 * the rule rests on.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { beginEffect, reportEffect, decideApproval } =
  await import('../../src/domain/effects.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

const $ = (dollars: number) => Math.round(dollars * 1_000_000);
const LINE = $(5_000);

let ws: string, other: string, keyId: string, otherKeyId: string;
before(async () => {
  await setupDb();
  const a = await createWorkspace('va', `va-${Date.now()}@example.test`);
  const b = await createWorkspace('va2', `va2-${Date.now()}@example.test`);
  ws = a.workspaceId; other = b.workspaceId;
  keyId = a.key.id; otherKeyId = b.key.id;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM effects WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM effect_policies WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM webhook_endpoints WHERE workspace_id = ANY($1)', [[ws, other]]);
});

let n = 0;
const begin = (o: {
  workspace?: string; keyId?: string; cost?: number; key?: string; type?: string;
} = {}) => {
  n += 1;
  const k = o.key ?? `k${n}`;
  return beginEffect({
    workspaceId: o.workspace ?? ws,
    apiKeyId: o.keyId ?? keyId,
    apiKeyPrefix: 'test',
    keyDailyBudgetMicros: null,
    effectType: o.type ?? 'payment.refund',
    idempotencyKey: k,
    payload: { of: k },
    estimatedCostMicros: o.cost ?? 0,
  });
};

/** The rule an operator actually states, expressed as policy. */
const line = (o: {
  above?: number | null; ceiling?: number | null;
  mode?: 'allow' | 'require_approval' | 'deny'; workspace?: string;
} = {}) =>
  upsertPolicy(getPool(), o.workspace ?? ws, {
    effectType: 'payment.refund',
    approvalAboveMicros: o.above === undefined ? LINE : o.above,
    maxCostMicros: o.ceiling ?? null,
    mode: o.mode ?? 'allow',
  });

describe('the rule people actually have', () => {
  test('a refund over the line waits for a human', async () => {
    await line();
    const r = await begin({ cost: $(12_000) });
    assert.equal(r.decision, 'approval_required');
    assert.equal(r.state, 'awaiting_approval');
  });

  test('a refund under the line is not slowed down at all', async () => {
    await line();
    const r = await begin({ cost: $(120) });
    assert.equal(r.decision, 'execute',
      'the whole point is that routine work keeps flowing');
    assert.ok(r.leaseToken, 'and it gets a real lease');
  });

  test('exactly the line is above it', async () => {
    await line();
    assert.equal((await begin({ cost: LINE })).decision, 'approval_required',
      '"approve above $5,000" is read by humans as including $5,000');
    assert.equal((await begin({ cost: LINE - 1 })).decision, 'execute');
  });

  test('the reason names the amount and the line it crossed', async () => {
    await line();
    const r = await begin({ cost: $(12_000) });
    assert.match(r.reason!, /\$12,000\.00/);
    assert.match(r.reason!, /\$5,000\.00/);
    assert.match(r.reason!, /operator must approve/i);
  });

  test('no threshold set is the behaviour that was there before', async () => {
    await line({ above: null });
    assert.equal((await begin({ cost: $(999_999) })).decision, 'execute',
      'this must stay off unless an operator turns it on');
  });
});

describe('it raises the decision and never lowers it', () => {
  test('a small amount cannot talk its way out of an approval-only type', async () => {
    await line({ mode: 'require_approval' });
    assert.equal((await begin({ cost: 1 })).decision, 'approval_required',
      'declaring a penny must not downgrade a type an operator gated entirely');
  });

  test('a small amount cannot talk its way out of a denial', async () => {
    await line({ mode: 'deny' });
    assert.equal((await begin({ cost: 1 })).decision, 'denied');
  });

  test('under-declaring buys exactly what omitting the feature would have', async () => {
    await line();
    // A caller lying downward lands under the line — the same place it would
    // have been had no threshold existed. It gains nothing it did not have.
    const r = await begin({ cost: $(1) });
    assert.equal(r.decision, 'execute');
    // And the lie is on the record, which is what reconcile checks.
    const { rows } = await getPool().query(
      'SELECT declared_micros FROM effects WHERE workspace_id=$1', [ws]);
    assert.equal(Number(rows[0]!.declared_micros), $(1));
  });
});

describe('a threshold nothing counts toward is not a threshold', () => {
  test('omitting the cost is refused, not allowed through', async () => {
    await line();
    await assert.rejects(() => begin({ cost: 0 }), (e: any) => {
      assert.equal(e.code, 'cost_required');
      assert.equal(e.status, 400);
      return true;
    }, 'otherwise the control is bypassed by leaving one field out');
  });

  test('the refusal says which setting is asking for it', async () => {
    await line();
    await assert.rejects(() => begin({ cost: 0 }), (e: any) => {
      assert.match(e.message, /approval threshold/i);
      return true;
    });
  });

  test('with no threshold, an undeclared cost is still fine', async () => {
    await line({ above: null });
    assert.equal((await begin({ cost: 0 })).decision, 'execute',
      'this must not become a global requirement to declare costs');
  });
});

describe('where it sits relative to the ceiling that refuses', () => {
  test('allow below, hold in between, refuse above', async () => {
    await line({ above: LINE, ceiling: $(20_000) });
    assert.equal((await begin({ cost: $(100) })).decision, 'execute');
    assert.equal((await begin({ cost: $(9_000) })).decision, 'approval_required');
    await assert.rejects(() => begin({ cost: $(25_000) }), (e: any) => {
      assert.equal(e.code, 'cost_ceiling_exceeded');
      return true;
    });
  });

  test('a threshold above the ceiling is refused rather than stored dead', async () => {
    await assert.rejects(
      () => line({ above: $(20_000), ceiling: $(5_000) }),
      (e: any) => {
        assert.equal(e.code, 'approval_threshold_above_ceiling');
        assert.equal(e.status, 400);
        return true;
      },
      'it could never fire, and a policy that reads as configured but does '
      + 'nothing is worse than an error');
  });

  test('a threshold equal to the ceiling is a legal narrow band', async () => {
    await line({ above: $(5_000), ceiling: $(5_000) });
    // The ceiling refuses ABOVE itself, so exactly the ceiling survives to be approved.
    assert.equal((await begin({ cost: $(5_000) })).decision, 'approval_required');
  });
});

describe('the whole way through', () => {
  test('approve, begin again, and the lease is granted', async () => {
    await line();
    const first = await begin({ cost: $(12_000), key: 'big-1' });
    assert.equal(first.decision, 'approval_required');

    await decideApproval({
      workspaceId: ws, effectId: first.effectId, actor: 'ops@example.test', approve: true,
    });

    const second = await begin({ cost: $(12_000), key: 'big-1' });
    assert.equal(second.decision, 'execute', 'an approved effect proceeds on the next begin');
    assert.ok(second.leaseToken);

    const done = await reportEffect({
      workspaceId: ws, apiKeyId: keyId, apiKeyPrefix: 'test',
      effectId: second.effectId, leaseToken: second.leaseToken!,
      outcome: 'succeeded', result: { ok: true },
    });
    assert.equal(done.state, 'succeeded');
  });

  test('reject, and it is denied for good', async () => {
    await line();
    const first = await begin({ cost: $(12_000), key: 'big-2' });
    await decideApproval({
      workspaceId: ws, effectId: first.effectId, actor: 'ops@example.test', approve: false,
    });
    const second = await begin({ cost: $(12_000), key: 'big-2' });
    assert.equal(second.decision, 'denied');
  });

  test('a second begin while still waiting does not create a second effect', async () => {
    await line();
    const a = await begin({ cost: $(12_000), key: 'big-3' });
    const b = await begin({ cost: $(12_000), key: 'big-3' });
    assert.equal(b.decision, 'approval_required');
    assert.equal(b.effectId, a.effectId, 'at-most-once holds through the approval path too');
  });
});

describe('what the operator is told', () => {
  test('the event says the value triggered it, and what the line was', async () => {
    await getPool().query(
      `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events)
       VALUES ($1,$2,'https://example.test/hook','whsec_test',$3)`,
      [`wh_va_${Date.now()}`, ws, ['effect.approval_required']]);
    await line();
    await begin({ cost: $(12_000) });

    const { rows } = await getPool().query<{ payload: any }>(
      `SELECT payload FROM webhook_deliveries
        WHERE workspace_id=$1 AND event_type='effect.approval_required'`, [ws]);
    assert.equal(rows.length, 1);
    const body = typeof rows[0]!.payload === 'string'
      ? JSON.parse(rows[0]!.payload) : rows[0]!.payload;
    const data = body.data ?? body;
    assert.equal(data.trigger, 'value',
      'triaging a queue means knowing why each item is in it');
    assert.equal(Number(data.approvalAboveMicros), LINE);
    assert.equal(Number(data.estimatedCostMicros), $(12_000));
  });
});

describe('isolation', () => {
  test('one workspace\'s threshold does not gate another\'s work', async () => {
    await line({ workspace: ws });
    const mine = await begin({ cost: $(12_000) });
    const theirs = await begin({ workspace: other, keyId: otherKeyId, cost: $(12_000) });
    assert.equal(mine.decision, 'approval_required');
    assert.equal(theirs.decision, 'execute', 'they configured nothing');
  });
});
