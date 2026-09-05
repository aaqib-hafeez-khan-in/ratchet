// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { getPool, type Db } from '../db/pool.js';
import { config } from '../lib/config.js';
import { errors } from '../lib/errors.js';
import { newId, constantTimeEqual } from '../lib/ids.js';
import { kidFor } from './auth.js';
import { newSecret, verifyTotp, otpauthUri } from '../lib/totp.js';

/**
 * Second factor for operator actions.
 *
 * The boundary is the action, not the door. Opening the console and reading
 * effects needs no code; changing a policy, issuing a key, closing a circuit
 * breaker or spending money does. Gating the door instead would have been
 * easier and would have protected less — an API key still reaches the API.
 *
 * Verification is recorded on the SESSION, not the workspace, so verifying once
 * does not leave every other session elevated. It expires, which is the same
 * step-up pattern GitHub applies before it will accept a new signing key.
 */

/** How long a verification elevates a session. */
const STEP_UP_MS = 15 * 60 * 1000;
/** Consecutive failures before the workspace is locked out. */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const RECOVERY_CODES = 10;

interface SealedSecret { v: 1; kid: string; iv: string; tag: string; ct: string; }

/** A distinct key per purpose, so nothing derived from AUTH_SECRET collides. */
function keyFor(pepper: string): Buffer {
  return Buffer.from(hkdfSync('sha256', pepper, 'ratchet-mfa-v1', 'totp-secret-encryption', 32));
}

function peppers(): string[] {
  return [config.authSecret, ...config.retiredAuthSecrets];
}

export function seal(secretB32: string, pepper = config.authSecret): SealedSecret {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(pepper), iv);
  const ct = Buffer.concat([c.update(secretB32, 'utf8'), c.final()]);
  return {
    v: 1, kid: kidFor(pepper),
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Open a sealed secret with whichever configured pepper made it.
 *
 * Tries every pepper rather than trusting the stored kid alone: the kid says
 * which pepper was used, but a wrong or stale kid should not make a recoverable
 * secret unrecoverable. GCM authenticates, so a wrong key fails loudly.
 */
export function unseal(sealed: SealedSecret): { secret: string; pepper: string } {
  for (const pepper of peppers()) {
    try {
      const d = createDecipheriv('aes-256-gcm', keyFor(pepper), Buffer.from(sealed.iv, 'base64'));
      d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const out = Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]);
      return { secret: out.toString('utf8'), pepper };
    } catch { /* wrong pepper; try the next */ }
  }
  throw errors.internal('The stored second-factor secret cannot be opened with any configured AUTH_SECRET.');
}

function hashCode(code: string, pepper = config.authSecret): Buffer {
  return createHmac('sha256', pepper).update(`mfa-recovery:${code}`).digest();
}

/** Human-typable: no ambiguous characters, grouped for reading aloud. */
function newRecoveryCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n: number) => Array.from(randomBytes(n)).map((b) => A[b % A.length]).join('');
  return `${pick(5)}-${pick(5)}`;
}

export interface MfaState {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  lockedUntil: string | null;
}

export async function mfaState(db: Db, workspaceId: string): Promise<MfaState> {
  const { rows } = await db.query<{
    mfa_enabled_at: Date | null; mfa_locked_until: Date | null; remaining: string;
  }>(
    `SELECT w.mfa_enabled_at, w.mfa_locked_until,
            (SELECT count(*) FROM mfa_recovery_codes r
              WHERE r.workspace_id = w.id AND r.used_at IS NULL) AS remaining
       FROM workspaces w WHERE w.id = $1`, [workspaceId],
  );
  const r = rows[0];
  if (!r) throw errors.notFound('No such workspace.');
  return {
    enabled: r.mfa_enabled_at !== null,
    enabledAt: r.mfa_enabled_at?.toISOString() ?? null,
    recoveryCodesRemaining: Number(r.remaining),
    lockedUntil: r.mfa_locked_until && r.mfa_locked_until > new Date()
      ? r.mfa_locked_until.toISOString() : null,
  };
}

/**
 * Begin enrolment. Returns the secret once, and activates nothing.
 *
 * Nothing is enabled until a code proves the authenticator actually holds the
 * secret. Enabling on enrolment would lock out anyone whose scan failed.
 */
export async function beginEnrolment(
  db: Db, workspaceId: string, account: string,
): Promise<{ secret: string; uri: string }> {
  const state = await mfaState(db, workspaceId);
  if (state.enabled) throw errors.conflict('mfa_already_enabled', 'Two-factor authentication is already on.');
  const secret = newSecret();
  await db.query('UPDATE workspaces SET mfa_secret = $2 WHERE id = $1',
    [workspaceId, JSON.stringify(seal(secret))]);
  return { secret, uri: otpauthUri(secret, account, 'Ratchet') };
}

async function loadSecret(db: Db, workspaceId: string): Promise<string | null> {
  const { rows } = await db.query<{ mfa_secret: SealedSecret | null }>(
    'SELECT mfa_secret FROM workspaces WHERE id = $1', [workspaceId]);
  const sealed = rows[0]?.mfa_secret;
  return sealed ? unseal(sealed).secret : null;
}

/** Turn it on, and hand back the recovery codes. Shown exactly once. */
export async function activate(
  db: Db, workspaceId: string, code: string,
): Promise<{ recoveryCodes: string[] }> {
  const secret = await loadSecret(db, workspaceId);
  if (!secret) throw errors.invalid('Start enrolment before activating.');
  if (!verifyTotp(secret, code)) throw errors.invalid('That code is not right.');

  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await db.query('DELETE FROM mfa_recovery_codes WHERE workspace_id = $1', [workspaceId]);
  for (const c of codes) {
    await db.query(
      `INSERT INTO mfa_recovery_codes (id, workspace_id, code_hash, secret_kid)
       VALUES ($1,$2,$3,$4)`,
      [newId('mrc'), workspaceId, hashCode(c), kidFor(config.authSecret)]);
  }
  await db.query(
    'UPDATE workspaces SET mfa_enabled_at = now(), mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1',
    [workspaceId]);
  return { recoveryCodes: codes };
}

/**
 * Check a code and, on success, elevate the session.
 *
 * A recovery code is accepted in place of a TOTP code and is burned on use.
 * Failures are counted and lock the workspace out, because six digits is a
 * million guesses against a window that never closes.
 */
export async function verifyAndElevate(
  db: Db, workspaceId: string, sessionId: string, code: string,
): Promise<{ ok: true; usedRecoveryCode: boolean }> {
  const state = await mfaState(db, workspaceId);
  if (!state.enabled) throw errors.invalid('Two-factor authentication is not on.');
  if (state.lockedUntil) {
    throw errors.rateLimited(
      `Too many incorrect codes. Try again after ${state.lockedUntil}.`);
  }

  const given = code.trim().toUpperCase();
  const secret = await loadSecret(db, workspaceId);
  let ok = secret ? verifyTotp(secret, code.trim()) : false;
  let usedRecoveryCode = false;

  if (!ok) {
    // Every unused code is compared, and the loop does not exit early, so a
    // wrong code takes the same time whichever position it would have matched.
    const { rows } = await db.query<{ id: string; code_hash: Buffer; secret_kid: string | null }>(
      `SELECT id, code_hash, secret_kid FROM mfa_recovery_codes
        WHERE workspace_id = $1 AND used_at IS NULL`, [workspaceId]);
    let hit: string | null = null;
    for (const row of rows) {
      for (const pepper of peppers()) {
        if (constantTimeEqual(hashCode(given, pepper), row.code_hash) && hit === null) {
          hit = row.id;
        }
      }
    }
    if (hit) {
      await db.query('UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1', [hit]);
      ok = true; usedRecoveryCode = true;
    }
  }

  if (!ok) {
    const { rows } = await db.query<{ mfa_failed: number }>(
      `UPDATE workspaces SET mfa_failed = mfa_failed + 1,
              mfa_locked_until = CASE WHEN mfa_failed + 1 >= $2
                THEN now() + ($3 || ' milliseconds')::interval ELSE mfa_locked_until END
        WHERE id = $1 RETURNING mfa_failed`,
      [workspaceId, MAX_FAILURES, String(LOCKOUT_MS)]);
    const left = MAX_FAILURES - (rows[0]?.mfa_failed ?? 0);
    throw errors.invalid(left > 0
      ? `That code is not right. ${left} attempt(s) before a temporary lockout.`
      : 'That code is not right. Too many attempts; locked out temporarily.');
  }

  await db.query('UPDATE workspaces SET mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1',
    [workspaceId]);
  await db.query('UPDATE console_sessions SET mfa_verified_at = now() WHERE id = $1', [sessionId]);
  return { ok: true, usedRecoveryCode };
}

/** Is this session currently elevated? */
export async function sessionIsElevated(db: Db, sessionId: string): Promise<boolean> {
  const { rows } = await db.query<{ mfa_verified_at: Date | null }>(
    'SELECT mfa_verified_at FROM console_sessions WHERE id = $1', [sessionId]);
  const at = rows[0]?.mfa_verified_at;
  return at !== null && at !== undefined && Date.now() - at.getTime() < STEP_UP_MS;
}

/** Turning it off requires a current code, or it is not a second factor. */
export async function disable(db: Db, workspaceId: string, sessionId: string, code: string) {
  await verifyAndElevate(db, workspaceId, sessionId, code);
  await db.query(
    `UPDATE workspaces
        SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_failed = 0, mfa_locked_until = NULL
      WHERE id = $1`, [workspaceId]);
  await db.query('DELETE FROM mfa_recovery_codes WHERE workspace_id = $1', [workspaceId]);
  await db.query('UPDATE console_sessions SET mfa_verified_at = NULL WHERE workspace_id = $1',
    [workspaceId]);
}

export const stepUpWindowMs = STEP_UP_MS;
export { getPool };
