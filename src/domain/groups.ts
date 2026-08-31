import type { PoolClient } from 'pg';
import { withTx, type Db } from '../db/pool.js';
import { newId, normalizeText } from '../lib/ids.js';
import { errors } from '../lib/errors.js';

/**
 * Reversible effect groups — sagas for agents.
 *
 * At-most-once answers "did this action happen?". It does not answer the
 * question that follows: "three of five steps happened and the fourth failed;
 * what now?" Today the agent is on its own, and the user is left holding a
 * booked flight for a trip that was never paid for.
 *
 * A group is a unit of work. Each effect in it may declare, up front, how to
 * undo itself. If the unit fails, Ratchet returns the exact compensation plan
 * in reverse completion order — because the last thing done is the first thing
 * that must be undone.
 *
 * The property that makes this safe rather than merely convenient: **a
 * compensation is itself an effect**, gated by the same machinery. The undo is
 * at-most-once too. Hand-rolled rollback is dangerous precisely because a
 * retried undo double-refunds; here that is structurally impossible.
 *
 * What this deliberately does NOT do: perform the compensation. Ratchet
 * executes nothing. It returns the plan; the agent acts and reports, exactly as
 * with any other effect.
 */

export type GroupState = 'open' | 'committed' | 'unwinding' | 'unwound' | 'unwind_failed';

export interface Compensation {
  effectType: string;
  payload: unknown;
}

export interface GroupRow {
  id: string;
  workspace_id: string;
  group_key: string;
  state: GroupState;
  unwind_reason: string | null;
  agent_id: string | null;
  created_at: Date;
  updated_at: Date;
  settled_at: Date | null;
}

/** Find or create the group for a caller-supplied key. */
export async function ensureGroup(
  tx: PoolClient, workspaceId: string, groupKey: string,
  agentId: string | null, retentionDays: number,
): Promise<GroupRow> {
  const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);
  const { rows } = await tx.query<GroupRow>(
    `INSERT INTO effect_groups (id, workspace_id, group_key, agent_id, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, group_key) DO UPDATE SET updated_at = now()
     RETURNING id, workspace_id, group_key, state, unwind_reason, agent_id,
               created_at, updated_at, settled_at`,
    [newId('grp'), workspaceId, normalizeText(groupKey), agentId, expiresAt],
  );
  return rows[0]!;
}

/**
 * A group that is unwinding will not accept new forward work. Letting an agent
 * add steps to a unit that is being rolled back produces exactly the
 * half-undone state this feature exists to prevent.
 */
export function assertAcceptsWork(group: GroupRow): void {
  if (group.state === 'unwinding' || group.state === 'unwound' || group.state === 'unwind_failed') {
    throw errors.conflict('group_unwinding',
      `This unit of work is being rolled back (${group.state}). It cannot take new steps. ` +
      'Start a new group if this is genuinely new work.',
      { groupState: group.state });
  }
}

export interface CompensationStep {
  order: number;
  originalEffectId: string;
  originalEffectType: string;
  originalIdempotencyKey: string;
  originalResult: unknown;
  compensation: Compensation;
  /** The key the caller should use when gating this compensation. */
  suggestedIdempotencyKey: string;
  status: 'pending' | 'done';
}

export interface UnwindPlan {
  groupId: string;
  groupKey: string;
  state: GroupState;
  reason: string | null;
  steps: CompensationStep[];
  /** Succeeded effects in the group that declared no way to undo themselves. */
  irreversible: Array<{
    effectId: string; effectType: string; idempotencyKey: string; result: unknown;
  }>;
  /** Effects whose real-world outcome is unknown; they may or may not need undoing. */
  unresolved: Array<{ effectId: string; effectType: string; state: string }>;
  nextStep: string;
}

/**
 * Begin rolling a group back, and return the plan.
 *
 * Reverse completion order, because dependencies run forward: if step 3 relied
 * on step 2, undoing 2 first can strand 3.
 */
export async function unwindGroup(args: {
  workspaceId: string; groupKey: string; reason?: string;
}): Promise<UnwindPlan> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<GroupRow>(
      `SELECT id, workspace_id, group_key, state, unwind_reason, agent_id,
              created_at, updated_at, settled_at
         FROM effect_groups WHERE workspace_id=$1 AND group_key=$2 FOR UPDATE`,
      [args.workspaceId, normalizeText(args.groupKey)],
    );
    const group = rows[0];
    if (!group) throw errors.notFound('No such group in this workspace.');

    if (group.state === 'open' || group.state === 'committed') {
      await tx.query(
        `UPDATE effect_groups SET state='unwinding', unwind_reason=$2, updated_at=now()
          WHERE id=$1`,
        [group.id, args.reason ?? 'Unwind requested.'],
      );
      group.state = 'unwinding';
      group.unwind_reason = args.reason ?? 'Unwind requested.';
    }

    return buildPlan(tx, group);
  });
}

async function buildPlan(tx: PoolClient | Db, group: GroupRow): Promise<UnwindPlan> {
  const { rows } = await tx.query(
    `SELECT id, effect_type, idempotency_key, state, result, compensation,
            compensated_at, group_seq
       FROM effects
      WHERE group_id = $1
      ORDER BY group_seq DESC`,
    [group.id],
  );

  const steps: CompensationStep[] = [];
  const irreversible: UnwindPlan['irreversible'] = [];
  const unresolved: UnwindPlan['unresolved'] = [];
  let order = 1;

  for (const r of rows) {
    // Only work that actually happened needs undoing.
    if (r.state === 'succeeded') {
      if (r.compensation) {
        steps.push({
          order: order++,
          originalEffectId: r.id,
          originalEffectType: r.effect_type,
          originalIdempotencyKey: r.idempotency_key,
          originalResult: r.result,
          compensation: {
            effectType: r.compensation.effectType ?? r.compensation.effect_type,
            payload: r.compensation.payload,
          },
          suggestedIdempotencyKey: `compensate:${r.id}`,
          status: r.compensated_at ? 'done' : 'pending',
        });
      } else {
        irreversible.push({
          effectId: r.id, effectType: r.effect_type,
          idempotencyKey: r.idempotency_key, result: r.result,
        });
      }
    } else if (r.state === 'indeterminate' || r.state === 'pending') {
      // Cannot be planned around: we do not know whether it happened.
      unresolved.push({ effectId: r.id, effectType: r.effect_type, state: r.state });
    }
  }

  const pending = steps.filter((s) => s.status === 'pending').length;
  const nextStep = unresolved.length > 0
    ? `STOP. ${unresolved.length} effect(s) in this group have an unknown outcome. Resolve those `
      + 'first — rolling back around an effect that may or may not have happened is how a '
      + 'half-undone state is created.'
    : pending > 0
      ? `Perform the ${pending} compensation(s) in the order given. Gate each one with `
        + 'ratchet_begin_effect using its suggested idempotency key, so the undo is itself '
        + 'at-most-once, then report the outcome.'
      : irreversible.length > 0
        ? `All reversible steps are undone. ${irreversible.length} effect(s) declared no `
          + 'compensation and cannot be rolled back automatically — a human must decide.'
        : 'Nothing left to undo. Call commit on the group to mark it unwound.';

  return {
    groupId: group.id,
    groupKey: group.group_key,
    state: group.state,
    reason: group.unwind_reason,
    steps, irreversible, unresolved, nextStep,
  };
}

/** Mark a compensation done and settle the group when nothing is outstanding. */
export async function markCompensated(
  tx: PoolClient, originalEffectId: string,
): Promise<void> {
  const { rows } = await tx.query<{ group_id: string | null }>(
    `UPDATE effects SET compensated_at = now(), updated_at = now()
      WHERE id = $1 AND compensated_at IS NULL
      RETURNING group_id`,
    [originalEffectId],
  );
  const groupId = rows[0]?.group_id;
  if (!groupId) return;

  const { rows: left } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM effects
      WHERE group_id = $1 AND state = 'succeeded'
        AND compensation IS NOT NULL AND compensated_at IS NULL`,
    [groupId],
  );
  if (Number(left[0]!.n) > 0) return;

  // Everything reversible is reversed. If anything irreversible succeeded, the
  // group is NOT cleanly unwound and must not claim to be.
  const { rows: stuck } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM effects
      WHERE group_id = $1 AND state = 'succeeded' AND compensation IS NULL`,
    [groupId],
  );
  const finalState = Number(stuck[0]!.n) > 0 ? 'unwind_failed' : 'unwound';
  await tx.query(
    `UPDATE effect_groups SET state=$2, settled_at=now(), updated_at=now()
      WHERE id=$1 AND state='unwinding'`,
    [groupId, finalState],
  );
}

export async function commitGroup(args: {
  workspaceId: string; groupKey: string;
}): Promise<{ groupId: string; state: GroupState }> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<GroupRow>(
      `SELECT id, state FROM effect_groups WHERE workspace_id=$1 AND group_key=$2 FOR UPDATE`,
      [args.workspaceId, normalizeText(args.groupKey)],
    );
    const g = rows[0];
    if (!g) throw errors.notFound('No such group in this workspace.');
    if (g.state === 'unwinding' || g.state === 'unwound' || g.state === 'unwind_failed') {
      throw errors.conflict('group_unwinding',
        `Cannot commit a group that is ${g.state}.`, { groupState: g.state });
    }
    await tx.query(
      `UPDATE effect_groups SET state='committed', settled_at=now(), updated_at=now() WHERE id=$1`,
      [g.id]);
    return { groupId: g.id, state: 'committed' as GroupState };
  });
}

export async function getGroup(
  db: Db, workspaceId: string, groupKey: string,
): Promise<UnwindPlan | null> {
  const { rows } = await db.query<GroupRow>(
    `SELECT id, workspace_id, group_key, state, unwind_reason, agent_id,
            created_at, updated_at, settled_at
       FROM effect_groups WHERE workspace_id=$1 AND group_key=$2`,
    [workspaceId, normalizeText(groupKey)],
  );
  return rows[0] ? buildPlan(db, rows[0]) : null;
}

export async function listGroups(db: Db, workspaceId: string, limit = 50) {
  const { rows } = await db.query(
    `SELECT g.id, g.group_key, g.state, g.unwind_reason, g.agent_id, g.created_at,
            count(e.id) AS effects,
            count(e.id) FILTER (WHERE e.compensation IS NOT NULL
                                  AND e.compensated_at IS NULL
                                  AND e.state='succeeded') AS pending_compensations
       FROM effect_groups g LEFT JOIN effects e ON e.group_id = g.id
      WHERE g.workspace_id = $1
      GROUP BY g.id ORDER BY g.created_at DESC LIMIT $2`,
    [workspaceId, Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    groupId: r.id, groupKey: r.group_key, state: r.state,
    unwindReason: r.unwind_reason, agentId: r.agent_id,
    effects: Number(r.effects), pendingCompensations: Number(r.pending_compensations),
    createdAt: r.created_at.toISOString(),
  }));
}
