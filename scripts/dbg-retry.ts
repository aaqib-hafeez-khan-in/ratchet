import 'dotenv/config';
import { getPool, closePool } from '../src/db/pool.js';
import { createWorkspace } from '../src/domain/auth.js';
import { beginEffect, reportEffect } from '../src/domain/effects.js';

const ws = await createWorkspace('Retry Dbg', `retry-${Date.now()}@example.test`);
const key = `retry-dbg-${Date.now()}`;
const call = () => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'email.send', idempotencyKey: key,
  payload: {}, estimatedCostMicros: 0,
});

const first = await call();
console.log('  1st begin      :', first.decision, 'attempt', first.attempt);

const rep = await reportEffect({
  workspaceId: ws.workspaceId, effectId: first.effectId,
  leaseToken: first.leaseToken!, outcome: 'failed', error: 'smtp timeout',
});
console.log('  report failed  :', rep.state);

const retry = await call();
console.log('  retry begin    :', retry.decision, 'attempt', retry.attempt,
            retry.reason ? `\n  reason: ${retry.reason}` : '');

const { rows } = await getPool().query(
  `SELECT state, attempt, max_attempts FROM effects e
     LEFT JOIN effect_policies p ON p.workspace_id=e.workspace_id AND p.effect_type=e.effect_type
    WHERE e.id=$1`, [first.effectId]);
console.log('  db row         :', JSON.stringify(rows[0]));
await closePool();
