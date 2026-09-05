// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { createHmac } from 'node:crypto';
import { getPool, type Db } from '../db/pool.js';
import { config } from '../lib/config.js';

/**
 * Who may conjure a workspace out of nothing.
 *
 * The keyless `begin` is the thing that makes Ratchet usable by an agent that
 * found the service on its own, and it is also the only place a stranger can
 * obtain something of value without presenting anything. Those are the same
 * property, so the answer is not to remove it but to bound it honestly.
 *
 * Two ceilings, because they fail differently:
 *
 *   **Per source** stops the obvious case — one script in a loop. It is keyed
 *   on a hash of the address, so it counts repeat offenders without keeping a
 *   log of who visited. An address is trivially rotated, so this ceiling alone
 *   is close to decorative against anyone deliberate.
 *
 *   **Global** is the one that actually holds. Rotating addresses does not move
 *   it. When it is reached, keyless provisioning stops for everyone and the
 *   caller is told to create a workspace the ordinary way; every request that
 *   presents a key is completely unaffected. That is deliberately the same
 *   shape as the surge containment we sell: stop the cheap unbounded thing,
 *   keep serving everyone who is identified.
 *
 * Both counters live in Postgres. In memory they were per instance and reset on
 * deploy, which made the published limit roughly fictional.
 */

/** Counted, never stored. We need repeat detection, not identification. */
export function sourceHash(ip: string): string {
  return createHmac('sha256', config.authSecret)
    .update(`provision:${ip}`)
    .digest('base64url')
    .slice(0, 22);
}

export type ProvisionDecision =
  | { allowed: true }
  | { allowed: false; scope: 'source' | 'global' };

const hourStart = (at = new Date()) =>
  new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);

/**
 * Claim one provisioning slot, or refuse.
 *
 * Each ceiling is claimed in a single statement, so the check and the increment
 * happen under the same row lock. Read-then-write here would let a burst of
 * concurrent callers all observe a count below the limit and all pass, which is
 * exactly how the feedback ceiling leaked 85 rows through a limit of 60.
 *
 * The source ceiling is claimed first because it is the cheaper filter and the
 * common refusal. A caller refused by it has not consumed global headroom.
 */
export async function claimProvisionSlot(
  ip: string, db: Db = getPool(),
): Promise<ProvisionDecision> {
  const hour = hourStart();

  const perSource = await db.query<{ count: number }>(
    `INSERT INTO provision_windows (source_hash, hour_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (source_hash, hour_start) DO UPDATE
       SET count = provision_windows.count + 1
       WHERE provision_windows.count < $3
     RETURNING count`,
    [sourceHash(ip), hour, config.provisionPerSourcePerHour],
  );
  if (!perSource.rows.length) return { allowed: false, scope: 'source' };

  const global = await db.query<{ count: number }>(
    `INSERT INTO provision_global (hour_start, count) VALUES ($1, 1)
     ON CONFLICT (hour_start) DO UPDATE
       SET count = provision_global.count + 1
       WHERE provision_global.count < $2
     RETURNING count`,
    [hour, config.provisionGlobalPerHour],
  );
  if (!global.rows.length) {
    // The source slot is already spent. Refunding it would need a transaction
    // around both statements for a case that only happens while we are at the
    // global ceiling anyway, and over-counting is the safe direction.
    return { allowed: false, scope: 'global' };
  }

  return { allowed: true };
}

/** What the ceilings are doing right now. Read by the worker's health report. */
export async function provisionPressure(db: Db = getPool()): Promise<{
  thisHour: number; ceiling: number; sources: number; atCeiling: boolean;
}> {
  const hour = hourStart();
  const [g, s] = await Promise.all([
    db.query<{ count: number }>(
      'SELECT count FROM provision_global WHERE hour_start = $1', [hour]),
    db.query<{ n: string }>(
      'SELECT count(*) AS n FROM provision_windows WHERE hour_start = $1', [hour]),
  ]);
  const thisHour = g.rows[0]?.count ?? 0;
  return {
    thisHour,
    ceiling: config.provisionGlobalPerHour,
    sources: Number(s.rows[0]?.n ?? 0),
    atCeiling: thisHour >= config.provisionGlobalPerHour,
  };
}

/** Drop windows nothing will read again. Called by the worker GC sweep. */
export async function gcProvisionWindows(db: Db = getPool()): Promise<number> {
  const [a, b] = await Promise.all([
    db.query("DELETE FROM provision_windows WHERE hour_start < now() - interval '3 hours'"),
    db.query("DELETE FROM provision_global  WHERE hour_start < now() - interval '48 hours'"),
  ]);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}
