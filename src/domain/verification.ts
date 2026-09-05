// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { getPool, type Db } from '../db/pool.js';
import { config } from '../lib/config.js';

/**
 * Proving the address a free plan is attached to.
 *
 * Claiming a workspace lifted the cap from 100 gated effects to the free plan's
 * 1,000, and nothing checked the address existed. One source could open five
 * workspaces an hour, each a full plan, with addresses that never had to answer.
 *
 * What this gates is the ALLOWANCE, never the signup. A workspace is created and
 * a usable key returned in one request exactly as before; it starts at the
 * unclaimed cap until the address replies. A person clicks a link once. Somebody
 * farming plans now needs a reachable inbox per workspace, which is the cost
 * that was missing.
 *
 * The token is stored the same way an API key is: HMAC-SHA256 under AUTH_SECRET,
 * never in the clear. A verification link is a bearer credential — it flips
 * billing state for anyone holding it — and a database leak should not hand
 * somebody a drawer full of working ones.
 */

/** Long enough that guessing is hopeless, short enough to survive an email client. */
const TOKEN_BYTES = 32;

/** Past this, a link is refused and a new one must be sent. */
export const TOKEN_TTL_HOURS = 48;

const hash = (token: string): Buffer =>
  createHmac('sha256', config.authSecret).update(`verify:${token}`).digest();

/**
 * Issue a link for a workspace. Returns the plaintext token, which is shown
 * exactly once — in the email — and never stored.
 */
export async function issueVerification(
  workspaceId: string, db: Db = getPool(),
): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await db.query(
    `UPDATE workspaces
        SET verification_hash = $2, verification_sent_at = now()
      WHERE id = $1`,
    [workspaceId, hash(token).toString('base64')],
  );
  return token;
}

export type VerifyResult =
  | { ok: true; workspaceId: string; alreadyVerified: boolean }
  | { ok: false; reason: 'unknown' | 'expired' };

/**
 * Redeem a link.
 *
 * Idempotent on purpose: mail clients prefetch links and people click twice, so
 * a second redemption reports success rather than an error nobody can act on.
 *
 * The token is deliberately NOT cleared on first use. Clearing it looked tidier
 * and made the second click report "we do not recognise that link" — a frightening
 * message for someone whose account is fine, and the exact case this comment
 * claimed to handle. Idempotency now comes from `email_verified_at`, and the
 * token is left inert: the only thing it can do is set a flag that is already
 * set, so a leaked link to a confirmed workspace grants nothing.
 */
export async function redeemVerification(
  token: string, db: Db = getPool(),
): Promise<VerifyResult> {
  const digest = hash(token).toString('base64');

  const { rows } = await db.query<{
    id: string; email_verified_at: Date | null; verification_sent_at: Date | null;
    verification_hash: string;
  }>(
    `SELECT id, email_verified_at, verification_sent_at, verification_hash
       FROM workspaces WHERE verification_hash = $1`,
    [digest],
  );
  const ws = rows[0];

  // No row means no such token. A real one always finds its workspace, whether
  // or not it has been used before.
  if (!ws) return { ok: false, reason: 'unknown' };

  // Constant time, even though the lookup above already matched: the comparison
  // habit is what survives a refactor that changes how the row is found.
  const a = Buffer.from(ws.verification_hash, 'base64');
  const b = hash(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'unknown' };
  }

  const sentAt = ws.verification_sent_at?.getTime() ?? 0;
  if (Date.now() - sentAt > TOKEN_TTL_HOURS * 3_600_000) {
    return { ok: false, reason: 'expired' };
  }

  const already = ws.email_verified_at !== null;
  await db.query(
    `UPDATE workspaces
        SET email_verified_at = COALESCE(email_verified_at, now())
      WHERE id = $1`,
    [ws.id],
  );
  return { ok: true, workspaceId: ws.id, alreadyVerified: already };
}

/** Whether this workspace's allowance is the plan's, or still the unclaimed cap. */
export async function isVerified(
  workspaceId: string, db: Db = getPool(),
): Promise<boolean> {
  const { rows } = await db.query<{ email_verified_at: Date | null }>(
    'SELECT email_verified_at FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0]?.email_verified_at != null;
}
