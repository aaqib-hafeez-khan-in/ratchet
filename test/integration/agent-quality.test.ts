// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Agent reliability, computed from records the gate already keeps.
 *
 * The tests that matter here are the ones about restraint: a metric computed
 * from four samples must come back null rather than as a number somebody will
 * put on a dashboard, and a workspace must never see another workspace's agents.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { listAgents, agentReliability } = await import('../../src/domain/agent-quality.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

let ws: string, other: string;
before(async () => {
  await setupDb();
  ws = (await createWorkspace('aq', `aq-${Date.now()}@example.test`)).workspaceId;
  other = (await createWorkspace('aq2', `aq2-${Date.now()}@example.test`)).workspaceId;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  await getPool().query('DELETE FROM effects WHERE workspace_id = ANY($1)', [[ws, other]]);
  await getPool().query('DELETE FROM receipts WHERE workspace_id = ANY($1)', [[ws, other]]);
});

/**
 * Insert effects directly. The state machine is exercised thoroughly elsewhere;
 * what is under test here is the arithmetic over what it leaves behind, and
 * seeding the rows is the only way to control the shape precisely.
 */
let n = 0;
async function effect(o: {
  workspace?: string; agent?: string | null; state?: string; type?: string;
  key?: string; fingerprint?: string; declared?: number; actual?: number;
  heldSeconds?: number; ageDays?: number;
}) {
  n += 1;
  const id = `eff_aq${n}_${Date.now().toString(36)}`;
  const settled = o.state === 'succeeded' || o.state === 'failed';
  await getPool().query(
    `INSERT INTO effects
       (id, workspace_id, effect_type, idempotency_key, fingerprint, state, agent_id,
        declared_micros, actual_micros, created_at, expires_at,
        lease_granted_at, settled_at)
     VALUES ($1,$2,$3,$4,decode($5,'hex'),$6,$7,$8,$9,
             now() - make_interval(days => $10), now() + interval '30 days',
             CASE WHEN $11::numeric IS NULL THEN NULL ELSE now() END,
             CASE WHEN $11::numeric IS NULL THEN NULL
                  ELSE now() + make_interval(secs => $11) END)`,
    [id, o.workspace ?? ws, o.type ?? 'email.send', o.key ?? `k${n}`,
     (o.fingerprint ?? `${n}`).padStart(64, '0'), o.state ?? 'succeeded',
     o.agent === undefined ? 'agent-a' : o.agent,
     o.declared ?? 0, o.actual ?? 0, o.ageDays ?? 0,
     settled && o.heldSeconds !== undefined ? o.heldSeconds : null]);
  return id;
}

const receipt = (workspace: string, effectId: string, decision: string) =>
  getPool().query(
    `INSERT INTO receipts (workspace_id, effect_id, decision, attempt, body, signature, body_hash)
     VALUES ($1,$2,$3,0,'{}','sig','hash')`, [workspace, effectId, decision]);

describe('reporting is the headline', () => {
  test('an agent that reports everything scores 1', async () => {
    for (let i = 0; i < 25; i += 1) await effect({ state: 'succeeded' });
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.reporting.concluded, 25);
    assert.equal(p.reporting.reportRate, 1);
    assert.deepEqual(p.concerns, []);
  });

  test('effects that expired unreported drag it down, and are named', async () => {
    for (let i = 0; i < 20; i += 1) await effect({ state: 'succeeded' });
    for (let i = 0; i < 5; i += 1) await effect({ state: 'indeterminate' });
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.reporting.unreported, 5);
    assert.equal(p.reporting.reportRate, 0.8);
    const c = p.concerns.find((x) => x.code === 'unreported_outcomes');
    assert.ok(c, 'five unreported outcomes should be a concern');
    assert.match(c.detail, /never\s+reported/);
  });

  test('effects still in flight are not counted as failures to report', async () => {
    for (let i = 0; i < 20; i += 1) await effect({ state: 'succeeded' });
    for (let i = 0; i < 10; i += 1) await effect({ state: 'pending' });
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.volume.effects, 30);
    assert.equal(p.reporting.concluded, 20, 'a live lease has not concluded anything yet');
    assert.equal(p.reporting.reportRate, 1);
  });
});

describe('restraint', () => {
  test('a rate computed from four samples comes back null', async () => {
    for (let i = 0; i < 3; i += 1) await effect({ state: 'succeeded' });
    await effect({ state: 'indeterminate' });
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.reporting.concluded, 4);
    assert.equal(p.reporting.reportRate, null,
      'four samples is not a rate, and a dashboard would treat it as one');
    assert.deepEqual(p.concerns, [], 'and nothing may be asserted from it');
  });

  test('an agent this workspace has never seen is nothing, not a zeroed profile', async () => {
    await effect({ state: 'succeeded' });
    assert.equal(await agentReliability(getPool(), ws, 'never-here', 30), null);
  });

  test('the window excludes what fell outside it', async () => {
    for (let i = 0; i < 5; i += 1) await effect({ state: 'succeeded', ageDays: 60 });
    for (let i = 0; i < 3; i += 1) await effect({ state: 'succeeded', ageDays: 1 });
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.volume.effects, 3);
  });
});

describe('idempotency key hygiene', () => {
  /**
   * The signal only a service holding payload fingerprints can see: the same
   * work arriving under a fresh key each time, which defeats the gate silently.
   */
  test('identical work under many keys is caught', async () => {
    // 20 pieces of work submitted honestly.
    for (let i = 0; i < 20; i += 1) {
      await effect({ state: 'succeeded', fingerprint: `a${i}`, key: `honest-${i}` });
    }
    // Two pieces of work, five keys each — an agent minting a UUID per attempt.
    for (const w of ['ffff', 'eeee']) {
      for (let i = 0; i < 5; i += 1) {
        await effect({ state: 'succeeded', fingerprint: w, key: `uuid-${w}-${i}` });
      }
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.keys.distinctWork, 22);
    assert.equal(p.keys.workSubmittedUnderSeveralKeys, 2);
    const c = p.concerns.find((x) => x.code === 'idempotency_key_churn');
    assert.ok(c, 'nearly a tenth of this agent\'s work is unrecognisable as a retry');
    assert.match(c.detail, /Derive the key from the work/);
  });

  test('one piece of work under many keys is one churned item, not many', async () => {
    for (let i = 0; i < 25; i += 1) {
      await effect({ state: 'succeeded', fingerprint: 'abcd', key: `same-work-${i}` });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.keys.distinctWork, 1, 'twenty-five submissions of one thing is one thing');
    assert.equal(p.keys.workSubmittedUnderSeveralKeys, 1);
    assert.equal(p.keys.churnRate, null, 'one work item cannot carry an accusation');
  });

  /**
   * Found by running real traffic through the endpoint rather than by reading it.
   * An agent doing six kinds of thing repeatedly, minting a UUID key each time,
   * defeats the gate completely — and the first version stayed silent, because
   * the volume floor was applied to "six distinct pieces of work" instead of to
   * how much had actually been observed.
   */
  test('a busy agent with few distinct payloads is still caught', async () => {
    for (let i = 0; i < 24; i += 1) {
      await effect({ state: 'succeeded', fingerprint: `cc${i % 6}`, key: `uuid-${i}` });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.keys.distinctWork, 6);
    assert.equal(p.keys.workSubmittedUnderSeveralKeys, 6);
    assert.equal(p.keys.excessKeys, 18, 'eighteen calls the gate could not recognise as retries');
    assert.equal(p.keys.churnRate, 1);
    const c = p.concerns.find((x) => x.code === 'idempotency_key_churn');
    assert.ok(c, 'six payloads under twenty-four keys is the failure this metric exists for');
    assert.equal(c.severity, 'high');
    assert.match(c.detail, /18 more keys/);
  });

  test('one repeated thing on its own is not enough to accuse anybody', async () => {
    for (let i = 0; i < 24; i += 1) {
      await effect({ state: 'succeeded', fingerprint: 'dddd', key: `daily-${i}` });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.keys.distinctWork, 1);
    assert.equal(p.keys.churnRate, null,
      'a single thing sent repeatedly is what a daily reminder looks like');
    assert.deepEqual(p.concerns, []);
  });

  test('different work under different keys is exactly right, and silent', async () => {
    for (let i = 0; i < 25; i += 1) {
      await effect({ state: 'succeeded', fingerprint: `bb${i}`, key: `w${i}` });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.keys.workSubmittedUnderSeveralKeys, 0);
    assert.equal(p.keys.churnRate, 0);
    assert.deepEqual(p.concerns, []);
  });
});

describe('cost declaration', () => {
  test('spending money without declaring it is a concern', async () => {
    for (let i = 0; i < 6; i += 1) {
      await effect({ state: 'succeeded', declared: 0, actual: 500_000 });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.cost.declaredNothing, 6);
    const c = p.concerns.find((x) => x.code === 'undeclared_cost');
    assert.ok(c);
    assert.match(c.detail, /can never fire/);
  });

  test('an agent that systematically under-declares is caught', async () => {
    for (let i = 0; i < 10; i += 1) {
      await effect({ state: 'succeeded', declared: 100_000, actual: 300_000 });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.cost.measurable, 10);
    assert.equal(p.cost.medianAccuracy, 3);
    assert.equal(p.cost.underDeclared, 10);
    assert.ok(p.concerns.some((c) => c.code === 'under_declared_cost'));
  });

  test('accurate estimates say nothing at all', async () => {
    for (let i = 0; i < 10; i += 1) {
      await effect({ state: 'succeeded', declared: 200_000, actual: 200_000 });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.cost.medianAccuracy, 1);
    assert.deepEqual(p.concerns, []);
  });
});

describe('decisions come from receipts, because duplicates create no effect', () => {
  test('retry behaviour is visible even though it writes no new row', async () => {
    const id = await effect({ state: 'succeeded' });
    await receipt(ws, id, 'execute');
    for (let i = 0; i < 6; i += 1) await receipt(ws, id, 'duplicate');
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.decisions['execute'], 1);
    assert.equal(p.decisions['duplicate'], 6,
      'six replays against one effect, and only one effect row to show for it');
  });

  test('an impatient agent is named', async () => {
    const id = await effect({ state: 'pending' });
    await receipt(ws, id, 'execute');
    for (let i = 0; i < 20; i += 1) await receipt(ws, id, 'in_flight');
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    const c = p.concerns.find((x) => x.code === 'impatient_retries');
    assert.ok(c, 'asking again while holding a live lease should be pointed out');
    assert.match(c.detail, /retry_after_seconds/);
  });
});

describe('lease hold', () => {
  test('how long the agent sits on permission before reporting', async () => {
    for (let i = 0; i < 10; i += 1) {
      await effect({ state: 'succeeded', heldSeconds: 4 });
    }
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.lease.measured, 10);
    assert.ok(p.lease.medianHoldSeconds !== null);
    assert.ok(Math.abs(p.lease.medianHoldSeconds - 4) < 1.5,
      `expected about 4s, got ${p.lease.medianHoldSeconds}`);
  });

  test('effects begun before the column existed are excluded, not counted as zero', async () => {
    for (let i = 0; i < 10; i += 1) await effect({ state: 'succeeded' });  // no lease_granted_at
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.lease.measured, 0);
    assert.equal(p.lease.medianHoldSeconds, null,
      'an unmeasured effect must not average in as an instant report');
  });
});

describe('tenant isolation', () => {
  test('one workspace never sees another workspace\'s agents', async () => {
    for (let i = 0; i < 5; i += 1) await effect({ workspace: other, agent: 'secret-agent' });
    await effect({ workspace: ws, agent: 'agent-a' });

    const mine = await listAgents(getPool(), ws, 30);
    assert.deepEqual(mine.map((a) => a.agentId), ['agent-a']);
    assert.equal(await agentReliability(getPool(), ws, 'secret-agent', 30), null,
      'a cross-tenant lookup must not confirm the agent exists elsewhere');
  });

  test('receipts from another workspace do not leak into decision counts', async () => {
    const mine = await effect({ workspace: ws, agent: 'agent-a', state: 'succeeded' });
    await receipt(ws, mine, 'execute');
    // Same effect id referenced under the other workspace: the join must be
    // scoped by workspace, not only by effect id.
    await receipt(other, mine, 'blocked');
    const p = (await agentReliability(getPool(), ws, 'agent-a', 30))!;
    assert.equal(p.decisions['execute'], 1);
    assert.equal(p.decisions['blocked'], undefined);
  });
});

describe('listing', () => {
  test('agents come back busiest first, with effects that carry no agent excluded', async () => {
    for (let i = 0; i < 3; i += 1) await effect({ agent: 'quiet' });
    for (let i = 0; i < 7; i += 1) await effect({ agent: 'busy' });
    for (let i = 0; i < 5; i += 1) await effect({ agent: null });
    const list = await listAgents(getPool(), ws, 30);
    assert.deepEqual(list.map((a) => a.agentId), ['busy', 'quiet']);
    assert.equal(list[0]!.effects, 7);
    assert.equal(list[0]!.reportRate, null, 'seven is still below the floor');
  });
});
