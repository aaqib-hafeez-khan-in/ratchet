// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { getPool, type Db } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { config } from '../lib/config.js';

/**
 * Transactional email.
 *
 * Ratchet's whole claim is that it tells you when something is uncertain. Until
 * now it did that only to whoever thought to open the console — an agent could
 * crash mid-charge at 3am and nobody would know. This closes that.
 *
 * Three rules the design turns on:
 *
 *  1. **A storm must collapse.** The dedupe key carries a time bucket, so five
 *     hundred indeterminate effects in an hour produce ONE email summarising
 *     them. Per-event mail is how a sender ends up in a spam folder, and the
 *     alert that mattered goes with it.
 *
 *  2. **Nothing sends from a request.** Queue and return; the worker delivers.
 *     A slow mail provider must never slow the gate.
 *
 *  3. **Only what the recipient needs to act on.** No payloads, no results, no
 *     keys — those live behind the console link. An email is an unencrypted
 *     copy that lives forever in someone's inbox.
 */

export const CATEGORIES = {
  indeterminate: 'Effects whose outcome is unknown and need verifying',
  rollback: 'Rollbacks that are incomplete or could not finish',
  approval: 'Effects waiting on your approval',
  containment: 'Circuit breakers that have opened',
  billing: 'Receipts, refunds, and plan changes',
  usage: 'Allowance running low or exhausted',
  security: 'API keys created or revoked',
  welcome: 'Getting started',
} as const;

export type Category = keyof typeof CATEGORIES;

/** Alerts a person acts on. Sent unless explicitly disabled. */
const OPERATIONAL: Category[] =
  ['indeterminate', 'rollback', 'approval', 'containment', 'usage', 'security'];

export interface Queued { queued: boolean; reason?: string; }

/**
 * Queue one message. Idempotent on (workspace, dedupeKey) — the same key inside
 * the same window collapses to a single send.
 */
export async function queueEmail(args: {
  workspaceId: string;
  category: Category;
  dedupeKey: string;
  subject: string;
  text: string;
  html?: string;
  db?: Db;
}): Promise<Queued> {
  const db = args.db ?? getPool();

  const { rows } = await db.query<{
    owner_email: string | null; email_suppressed_at: Date | null; enabled: boolean | null;
  }>(
    `SELECT w.owner_email, w.email_suppressed_at, p.enabled
       FROM workspaces w
       LEFT JOIN email_preferences p
              ON p.workspace_id = w.id AND p.category = $2
      WHERE w.id = $1`,
    [args.workspaceId, args.category],
  );
  const ws = rows[0];
  if (!ws) return { queued: false, reason: 'no such workspace' };
  // Anonymous workspaces have no owner. They are created by the zero-friction
  // path — any unauthenticated begin — and their agents crash like everyone
  // else's, so they accumulate exactly the conditions that generate alerts.
  // Without this the insert violates NOT NULL and the exception escapes the
  // sweep, silencing alerts for every workspace that sorts after it.
  if (!ws.owner_email) return { queued: false, reason: 'workspace has no owner address' };
  if (ws.email_suppressed_at) return { queued: false, reason: 'address suppressed' };
  // Absent preference means enabled, so a category added later still reaches
  // people who signed up before it existed.
  if (ws.enabled === false) return { queued: false, reason: 'opted out of this category' };

  const res = await db.query(
    `INSERT INTO email_messages
       (id, workspace_id, to_email, category, subject, body_text, body_html, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
    [newId('em'), args.workspaceId, ws.owner_email, args.category,
     args.subject, args.text, args.html ?? null, args.dedupeKey],
  );
  return (res.rowCount ?? 0) > 0
    ? { queued: true }
    : { queued: false, reason: 'already queued in this window' };
}

/** Time bucket for collapsing a storm into one message. */
export const bucket = (minutes: number, at = new Date()): string =>
  String(Math.floor(at.getTime() / (minutes * 60_000)));

export async function setPreference(
  workspaceId: string, category: Category, enabled: boolean,
): Promise<void> {
  await getPool().query(
    `INSERT INTO email_preferences (workspace_id, category, enabled)
     VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, category)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [workspaceId, category, enabled]);
}

export async function getPreferences(
  db: Db, workspaceId: string,
): Promise<Array<{ category: Category; description: string; enabled: boolean; operational: boolean }>> {
  const { rows } = await db.query<{ category: string; enabled: boolean }>(
    'SELECT category, enabled FROM email_preferences WHERE workspace_id = $1', [workspaceId]);
  const set = new Map(rows.map((r) => [r.category, r.enabled]));
  return (Object.keys(CATEGORIES) as Category[]).map((c) => ({
    category: c,
    description: CATEGORIES[c],
    enabled: set.get(c) ?? true,
    operational: OPERATIONAL.includes(c),
  }));
}

/** Stop sending to an address a provider has reported as permanently bad. */
export async function suppressAddress(workspaceId: string, reason: string): Promise<void> {
  await getPool().query(
    `UPDATE workspaces SET email_suppressed_at = now(), email_suppress_reason = $2
      WHERE id = $1 AND email_suppressed_at IS NULL`,
    [workspaceId, reason.slice(0, 300)]);
}

export async function listEmails(db: Db, workspaceId: string, limit = 25) {
  const { rows } = await db.query(
    `SELECT category, subject, state, attempts, last_error, created_at, sent_at
       FROM email_messages WHERE workspace_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, Math.min(limit, 100)]);
  return rows.map((r) => ({
    category: r.category, subject: r.subject, state: r.state, attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
    sentAt: r.sent_at ? r.sent_at.toISOString() : null,
  }));
}

export const emailEnabled = (): boolean =>
  config.email.provider !== 'log' ? config.email.apiKey.length > 0 : true;

/**
 * Whether outbound mail is actually going out.
 *
 * `deferred` is the number parked because the provider refused for lack of
 * sending budget. It reads as zero on a healthy day and is the only signal that
 * a spent quota is holding up verification links — the API, the worker and the
 * database all report perfect health while signups quietly fail to land.
 */
export async function emailQueueHealth(db: Db = getPool()): Promise<{
  queued: number; deferred: number; deadLastDay: number;
}> {
  const { rows } = await db.query<{ queued: string; deferred: string; dead: string }>(
    `SELECT count(*) FILTER (WHERE state = 'queued')                    AS queued,
            count(*) FILTER (WHERE state = 'queued' AND deferrals > 0)  AS deferred,
            count(*) FILTER (WHERE state = 'dead'
                               AND created_at > now() - interval '1 day') AS dead
       FROM email_messages`);
  return {
    queued: Number(rows[0]?.queued ?? 0),
    deferred: Number(rows[0]?.deferred ?? 0),
    deadLastDay: Number(rows[0]?.dead ?? 0),
  };
}
