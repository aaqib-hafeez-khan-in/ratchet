// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Put a workspace on a plan.
 *
 * Enterprise is sold, not bought: there is no list price and no checkout for it.
 * Something still has to grant it once a contract is signed, and this is that
 * something — deliberately a script against DATABASE_URL rather than an HTTP
 * endpoint. A new authenticated write path that can raise a customer's limits is
 * a new way in, and the operator already has database access. The smallest
 * surface that does the job is no surface at all.
 *
 *   npx tsx scripts/set-plan.ts ws_abc123 enterprise
 *   npx tsx scripts/set-plan.ts ws_abc123 free --reason "contract ended"
 *
 * Writes an audit event, because a plan change that leaves no trace is exactly
 * the kind of thing this product exists to object to.
 */
import { getPool, closePool } from '../src/db/pool.js';
import { PLANS, type PlanId } from '../src/domain/plans.js';

const [, , workspaceId, planId, ...rest] = process.argv;
const reasonAt = rest.indexOf('--reason');
const reason = reasonAt >= 0 ? rest[reasonAt + 1] : undefined;

function usage(problem: string): never {
  console.error(`\n  ${problem}\n`);
  console.error('  usage: npx tsx scripts/set-plan.ts <workspace_id> <plan> [--reason "..."]');
  console.error(`  plans: ${Object.keys(PLANS).join(', ')}\n`);
  process.exit(2);
}

if (!workspaceId || !planId) usage('A workspace id and a plan are required.');
if (!(planId in PLANS)) usage(`"${planId}" is not a plan.`);

const plan = PLANS[planId as PlanId];
const pool = getPool();

try {
  const { rows } = await pool.query<{ name: string; plan: string; owner_email: string | null }>(
    'SELECT name, plan, owner_email FROM workspaces WHERE id = $1', [workspaceId]);
  const ws = rows[0];
  if (!ws) usage(`No workspace ${workspaceId}.`);

  if (ws.plan === planId) {
    console.log(`\n  ${ws.name} is already on ${plan.name}. Nothing to do.\n`);
    process.exit(0);
  }

  // Subscription state is Stripe's business and this is not Stripe. Moving a
  // workspace by hand must not silently contradict a live subscription, so say
  // so rather than quietly winning the race with the next webhook.
  const { rows: sub } = await pool.query<{ subscription_status: string | null }>(
    'SELECT subscription_status FROM workspaces WHERE id = $1', [workspaceId]);
  const status = sub[0]?.subscription_status;
  if (status === 'active' && !plan.selfServe) {
    console.warn(`\n  WARNING: ${ws.name} has an ACTIVE Stripe subscription.`);
    console.warn('  The next subscription webhook will move it back. Cancel the subscription');
    console.warn('  in Stripe first, or this change will not hold.\n');
  }

  await pool.query('UPDATE workspaces SET plan = $2, updated_at = now() WHERE id = $1',
    [workspaceId, planId]);
  await pool.query(
    `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
     VALUES ($1,'billing.plan_set_by_operator','operator',$2,$3)`,
    [workspaceId, planId,
     JSON.stringify({ from: ws.plan, to: planId, reason: reason ?? null })]);

  console.log(`\n  ${ws.name}  ${ws.plan} → ${planId}`);
  console.log(`  ${plan.includedEffects.toLocaleString()} effects included · `
    + `${plan.rateLimitPerMinute.toLocaleString()}/min · ${plan.maxRetentionDays} day retention`);
  if (!plan.selfServe) {
    console.log('  This plan has no list price and cannot be reached through checkout.');
  }
  console.log(`  Recorded in the audit trail${reason ? ` — ${reason}` : ''}.\n`);
} finally {
  await closePool();
}
