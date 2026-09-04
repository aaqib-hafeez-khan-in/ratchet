// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { getPool, type Db } from '../db/pool.js';
import { newId } from '../lib/ids.js';

/**
 * Site feedback.
 *
 * Five separate usability problems reached us as screenshots forwarded by the
 * operator, days after the fact. Nothing on the site let a confused reader say
 * so. This is that channel, built under three constraints that matter more than
 * the feature itself.
 *
 *  1. **The text is data.** Nothing a stranger types here may influence control
 *     flow, and it is never rendered as HTML. It is stored, counted, and read by
 *     a human. The same rule the gate applies to agent-supplied payloads.
 *
 *  2. **No identity.** No cookie, no stored IP, no fingerprint. An email address
 *     is optional and exists only so we can reply to that one message. Two
 *     submissions from the same person are not linkable by us, deliberately:
 *     the value here is "which page confuses people", not "who is confused".
 *
 *  3. **It cannot become a spam pipe.** The route is unauthenticated, so its
 *     rate limit is per-IP and therefore evadable. A global per-minute ceiling
 *     in the database is not.
 */

/** Above this, we stop accepting for the rest of the minute. */
export const GLOBAL_PER_MINUTE = 60;

export const MAX_MESSAGE = 2000;

export interface Submission {
  path: string;
  wasClear: boolean;
  message?: string | null;
  replyTo?: string | null;
  viewport?: string | null;
}

/**
 * Remove anything that would make the stored text unsafe to read later. Control
 * characters can hide content from whoever reads a digest in a terminal, which
 * is the one place this text is ever displayed.
 */
function clean(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  // C0 controls and DEL, keeping newline and tab: someone describing a
  // layout problem may paste two lines, and flattening that loses the shape
  // of what they were showing us.
  const t = s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
  return t.length ? t : null;
}

/**
 * A stranger choosing the `path` value would otherwise decide what appears in
 * our own dashboard, which turns a report of "which pages confuse people" into
 * somewhere to write graffiti.
 */
const PATH_RE = /^\/[a-z0-9/_-]{0,80}$/;

export async function record(
  input: Submission, db: Db = getPool(),
): Promise<{ stored: boolean; reason?: string }> {
  if (!PATH_RE.test(input.path)) return { stored: false, reason: 'unrecognised path' };

  // Claim a slot and enforce the ceiling in ONE statement.
  //
  // The first version read the count, compared it, then incremented. Those are
  // three statements with no lock held across them, so eighty-five concurrent
  // callers all read a number below the ceiling before any of them incremented
  // and all eighty-five were stored. That is the same lost-update bug the spend
  // window had, and a test caught it here for the same reason.
  //
  // ON CONFLICT ... DO UPDATE takes a row lock for the duration of the
  // statement, and the WHERE decides under that lock. No row comes back when
  // the ceiling is reached, which is the refusal.
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO page_feedback_windows (minute_start, count) VALUES ($1, 1)
     ON CONFLICT (minute_start) DO UPDATE
       SET count = page_feedback_windows.count + 1
       WHERE page_feedback_windows.count < $2
     RETURNING count`,
    [minute, GLOBAL_PER_MINUTE],
  );
  if (!rows.length) return { stored: false, reason: 'too much feedback this minute' };

  // The slot is spent before the row is written, so a failure here costs one
  // slot rather than admitting one extra. Over-counting is the safe direction.
  await db.query(
    `INSERT INTO page_feedback (id, path, was_clear, message, reply_to, viewport)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [newId('fb'), input.path, input.wasClear,
      clean(input.message, MAX_MESSAGE), clean(input.replyTo, 254),
      clean(input.viewport, 24)],
  );
  return { stored: true };
}

export interface PathSummary {
  path: string;
  clear: number;
  unclear: number;
  withMessage: number;
  lastAt: string;
}

/** Which pages are failing, worst first. The report the operator actually needs. */
export async function summary(db: Db = getPool(), days = 30): Promise<PathSummary[]> {
  const { rows } = await db.query<{
    path: string; clear: string; unclear: string; with_message: string; last_at: Date;
  }>(
    `SELECT path,
            count(*) FILTER (WHERE was_clear)            AS clear,
            count(*) FILTER (WHERE NOT was_clear)        AS unclear,
            count(*) FILTER (WHERE message IS NOT NULL)  AS with_message,
            max(created_at)                              AS last_at
       FROM page_feedback
      WHERE created_at > now() - make_interval(days => $1)
      GROUP BY path
      ORDER BY count(*) FILTER (WHERE NOT was_clear) DESC, path`,
    [days],
  );
  return rows.map((r) => ({
    path: r.path,
    clear: Number(r.clear),
    unclear: Number(r.unclear),
    withMessage: Number(r.with_message),
    lastAt: r.last_at.toISOString(),
  }));
}

export interface FeedbackMessage {
  id: string;
  path: string;
  wasClear: boolean;
  message: string;
  replyTo: string | null;
  viewport: string | null;
  createdAt: string;
}

export async function messages(
  db: Db = getPool(), limit = 50,
): Promise<FeedbackMessage[]> {
  const { rows } = await db.query<{
    id: string; path: string; was_clear: boolean; message: string;
    reply_to: string | null; viewport: string | null; created_at: Date;
  }>(
    `SELECT id, path, was_clear, message, reply_to, viewport, created_at
       FROM page_feedback
      WHERE message IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    wasClear: r.was_clear,
    message: r.message,
    replyTo: r.reply_to,
    viewport: r.viewport,
    createdAt: r.created_at.toISOString(),
  }));
}

/** Discard windows we will never read again. Called by the worker GC sweep. */
export async function gcWindows(db: Db = getPool()): Promise<number> {
  const res = await db.query(
    "DELETE FROM page_feedback_windows WHERE minute_start < now() - interval '1 hour'");
  return res.rowCount ?? 0;
}
