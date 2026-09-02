import { getPool, withTx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { suppressAddress, queueEmail, bucket, type Category } from '../domain/email.js';
import * as tpl from '../domain/email-templates.js';

/**
 * Email delivery and alert generation.
 *
 * Two loops. One turns database state into queued alerts; the other delivers
 * what is queued. Keeping them apart means a mail outage delays alerts but
 * never loses them, and a storm of effects cannot become a storm of requests to
 * a mail provider.
 */

export interface SendOutcome {
  sent: boolean; providerId?: string; error?: string;
  retryable: boolean; suppress?: boolean;
  /**
   * Set when the provider refused for lack of *our* sending budget rather than
   * anything about the message. Nothing was offered to the recipient, so this
   * is not a delivery attempt — it is a wait, and the wait is until the quota
   * window turns over, not the few minutes the retry ladder would allow.
   */
  deferUntil?: Date;
}

/**
 * The next UTC midnight — when a daily sending quota resets, plus a minute so a
 * fleet of workers does not all wake against the boundary at once.
 */
function nextQuotaReset(now = new Date()): Date {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0));
  return d;
}

/** A message may wait out this many quota days before we admit it is stale. */
const MAX_DEFERRALS = 7;

/**
 * Quota exhaustion, told apart from ordinary throttling.
 *
 * Both arrive as 429. A per-second rate limit clears in seconds and the normal
 * backoff handles it; a daily quota does not clear until the day does, and
 * backing off by minutes against it just burns the message's retries.
 */
const isQuotaExhausted = (message: string) =>
  /quota|daily (sending )?limit|monthly limit|exceeded your .*plan/i.test(message);

/**
 * Provider adapters. Each is a single HTTPS POST, so no SDK and no dependency.
 * `log` is the default: it writes the message and sends nothing, which lets the
 * entire queue, retry, and dedupe path run without credentials — the same
 * approach the billing test adapter takes.
 */
async function send(msg: {
  to: string; subject: string; text: string; html: string | null;
}): Promise<SendOutcome> {
  const { provider, apiKey, from, replyTo } = config.email;

  if (provider === 'log' || !apiKey) {
    console.log(JSON.stringify({
      level: 'info', svc: 'email', msg: 'would send (log adapter — nothing was delivered)',
      to: msg.to, subject: msg.subject,
    }));
    return { sent: true, providerId: 'log', retryable: false };
  }

  try {
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [msg.to], subject: msg.subject, text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (res.ok) return { sent: true, providerId: body?.id, retryable: false };
      // 4xx other than throttling means the request itself is wrong; retrying
      // an unacceptable message just burns quota.
      const retryable = res.status >= 500 || res.status === 429;
      const message = String(body?.message ?? `HTTP ${res.status}`);
      return {
        sent: false, retryable, error: message,
        suppress: /invalid|not a valid|does not exist/i.test(message),
        ...(retryable && isQuotaExhausted(message) ? { deferUntil: nextQuotaReset() } : {}),
      };
    }

    if (provider === 'postmark') {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': apiKey,
          'content-type': 'application/json', accept: 'application/json',
        },
        body: JSON.stringify({
          From: from, To: msg.to, Subject: msg.subject,
          TextBody: msg.text, ...(msg.html ? { HtmlBody: msg.html } : {}),
          ...(replyTo ? { ReplyTo: replyTo } : {}),
          MessageStream: 'outbound',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (res.ok) return { sent: true, providerId: body?.MessageID, retryable: false };
      // 406 is Postmark's inactive-recipient code: a hard bounce or complaint.
      const suppress = body?.ErrorCode === 406 || res.status === 406;
      const retryable = res.status >= 500 || res.status === 429;
      const message = String(body?.Message ?? `HTTP ${res.status}`);
      return {
        sent: false, retryable,
        error: message, suppress,
        ...(retryable && isQuotaExhausted(message) ? { deferUntil: nextQuotaReset() } : {}),
      };
    }

    return { sent: false, retryable: false, error: `unknown email provider "${provider}"` };
  } catch (err) {
    return { sent: false, retryable: true, error: (err as Error).message.slice(0, 200) };
  }
}

const backoffMs = (attempt: number) => {
  const base = Math.min(30 * 60_000, 2000 * 2 ** attempt);
  return Math.floor(base / 2 + Math.random() * (base / 2));
};

/** Deliver one batch of due messages. */
export async function deliverEmails(batch = 10): Promise<number> {
  const claimed = await withTx(async (tx) => {
    const { rows } = await tx.query<{
      id: string; workspace_id: string; to_email: string; subject: string;
      body_text: string; body_html: string | null; attempts: number; deferrals: number;
    }>(
      // Priority, then age.
      //
      // Under a spent quota every deferred message comes due at the same instant
      // — the reset — and whatever the batch claims first is what actually gets
      // sent. Ordering by arrival there hands the recovered budget to a backlog
      // of operator digests while a new customer sits waiting for the link that
      // verifies their account. Someone is blocked on the first group and merely
      // informed by the second.
      `SELECT id, workspace_id, to_email, subject, body_text, body_html, attempts, deferrals
         FROM email_messages
        WHERE state = 'queued' AND next_attempt_at <= now()
        ORDER BY CASE category
                   WHEN 'welcome'  THEN 0
                   WHEN 'security' THEN 1
                   WHEN 'billing'  THEN 2
                   ELSE 3
                 END,
                 next_attempt_at
        LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch]);
    if (rows.length === 0) return [];
    await tx.query(
      `UPDATE email_messages SET state='sending', attempts = attempts + 1
        WHERE id = ANY($1::text[])`, [rows.map((r) => r.id)]);
    return rows;
  });

  for (const m of claimed) {
    const out = await send({
      to: m.to_email, subject: m.subject, text: m.body_text, html: m.body_html,
    });
    const attempts = m.attempts + 1;

    if (out.sent) {
      await getPool().query(
        `UPDATE email_messages SET state='sent', sent_at=now(), provider_id=$2, last_error=NULL
          WHERE id=$1`, [m.id, out.providerId ?? null]);
    } else if (out.suppress) {
      // The address is permanently bad. Continuing to send to it is how a
      // sending domain gets blocked, which then kills the alerts that matter.
      await suppressAddress(m.workspace_id, out.error ?? 'undeliverable');
      await getPool().query(
        `UPDATE email_messages SET state='suppressed', last_error=$2 WHERE id=$1`,
        [m.id, out.error ?? 'undeliverable']);
    } else if (out.deferUntil) {
      if (m.deferrals + 1 < MAX_DEFERRALS) {
        // We had no budget, so nothing was tried. Give the attempt back and wait
        // for the window to turn over — otherwise a single alert storm on a
        // shared sending quota silently destroys every signup behind it.
        await getPool().query(
          `UPDATE email_messages
              SET state='queued', attempts = attempts - 1, deferrals = deferrals + 1,
                  next_attempt_at = $2, last_error = $3
            WHERE id=$1`,
          [m.id, out.deferUntil, out.error ?? 'sending quota exhausted']);
      } else {
        // A week of this is not a quota blip, it is an unpaid or misconfigured
        // provider, and the notification is now too old to be worth delivering.
        await getPool().query(
          `UPDATE email_messages SET state='dead', last_error=$2 WHERE id=$1`,
          [m.id, `sending quota exhausted for ${MAX_DEFERRALS} days: ${out.error ?? ''}`.trim()]);
      }
    } else if (!out.retryable || attempts >= config.email.maxAttempts) {
      await getPool().query(
        `UPDATE email_messages SET state='dead', last_error=$2 WHERE id=$1`,
        [m.id, out.error ?? 'delivery failed']);
    } else {
      await getPool().query(
        `UPDATE email_messages
            SET state='queued', next_attempt_at = now() + ($2 || ' milliseconds')::interval,
                last_error=$3
          WHERE id=$1`,
        [m.id, String(backoffMs(attempts)), out.error ?? null]);
    }
  }
  return claimed.length;
}

/**
 * Turn current state into alerts.
 *
 * Runs on a timer rather than firing from each event, which is what makes the
 * digest possible: it counts what is outstanding right now and sends one
 * message about all of it. The time bucket in the dedupe key caps that at one
 * per workspace per window regardless of how many replicas run this.
 */
export async function generateAlerts(): Promise<number> {
  const db = getPool();
  let queued = 0;

  /**
   * One workspace must never be able to silence everybody else's alerts.
   *
   * This sweep walks every workspace with something to report. An exception
   * escaping mid-loop abandons the whole pass, so the workspaces that happen to
   * sort later simply never hear anything — the worst failure an alerting
   * system can have, because it is completely silent. It happened for real: an
   * anonymous workspace has no owner address, and queueEmail inserted NULL into
   * a NOT NULL column. Fixed at the source too, but the loop should survive the
   * next surprise as well.
   */
  const safeQueue = async (args: Parameters<typeof queueEmail>[0]) => {
    try {
      const q = await queueEmail(args);
      if (q.queued) queued++;
    } catch (err) {
      console.log(JSON.stringify({
        level: 'error', svc: 'email', msg: 'could not queue alert for workspace',
        workspaceId: args.workspaceId, category: args.category,
        err: (err as Error).message,
      }));
    }
  };

  // ---- effects with an unknown outcome ------------------------------------
  const { rows: indet } = await db.query<{ workspace_id: string; n: string; types: string[] }>(
    `SELECT workspace_id, count(*) AS n, array_agg(DISTINCT effect_type) AS types
       FROM effects WHERE state = 'indeterminate'
      GROUP BY workspace_id`);
  for (const r of indet) {
    const t = tpl.indeterminateAlert(Number(r.n), r.types);
    await safeQueue({
      workspaceId: r.workspace_id, category: 'indeterminate',
      // One per workspace per hour, however many effects are involved.
      dedupeKey: `indeterminate:${bucket(60)}`,
      subject: t.subject, text: t.text, html: t.html,
    });
  }

  // ---- rollbacks that are stuck or could not finish ------------------------
  const { rows: roll } = await db.query<{ workspace_id: string; stuck: string; failed: string }>(
    `SELECT g.workspace_id,
            count(*) FILTER (WHERE g.state = 'unwinding') AS stuck,
            count(*) FILTER (WHERE g.state = 'unwind_failed') AS failed
       FROM effect_groups g
      WHERE g.state IN ('unwinding','unwind_failed')
      GROUP BY g.workspace_id`);
  for (const r of roll) {
    const stuck = Number(r.stuck); const failed = Number(r.failed);
    if (stuck + failed === 0) continue;
    const t = tpl.rollbackAlert(stuck, failed);
    await safeQueue({
      workspaceId: r.workspace_id, category: 'rollback',
      dedupeKey: `rollback:${failed > 0 ? 'failed' : 'stuck'}:${bucket(120)}`,
      subject: t.subject, text: t.text, html: t.html,
    });
  }

  // ---- circuit breakers that are open --------------------------------------
  //
  // A tighter window than any other alert. An open breaker means work is being
  // held or refused right now, and the operator is the only one who can judge
  // whether that is correct. Containment nobody hears about is half a feature.
  const { rows: circuits } = await db.query<{
    workspace_id: string; effect_type: string; action: string;
    reason: string | null; resets_at: Date | null;
  }>(
    `SELECT workspace_id, effect_type, action, reason, resets_at
       FROM circuit_breakers
      WHERE state = 'open' AND (resets_at IS NULL OR resets_at > now())
      ORDER BY workspace_id, effect_type`);
  const byWorkspace = new Map<string, typeof circuits>();
  for (const r of circuits) {
    if (!byWorkspace.has(r.workspace_id)) byWorkspace.set(r.workspace_id, []);
    byWorkspace.get(r.workspace_id)!.push(r);
  }
  for (const [workspaceId, open] of byWorkspace) {
    const t = tpl.circuitAlert(open.map((c) => ({
      effectType: c.effect_type, action: c.action, reason: c.reason, resetsAt: c.resets_at,
    })));
    await safeQueue({
      workspaceId, category: 'containment',
      // Keyed on WHICH breakers are open, so a newly opened one sends a fresh
      // message instead of being swallowed by the previous digest's window.
      dedupeKey: `containment:${open.map((c) => c.effect_type).join(',')}:${bucket(15)}`,
      subject: t.subject, text: t.text, html: t.html,
    });
  }

  // ---- effects waiting on a person ----------------------------------------
  const { rows: appr } = await db.query<{ workspace_id: string; n: string }>(
    `SELECT workspace_id, count(*) AS n FROM effects
      WHERE state = 'awaiting_approval' AND approval_state = 'waiting'
      GROUP BY workspace_id`);
  for (const r of appr) {
    const t = tpl.approvalAlert(Number(r.n));
    await safeQueue({
      workspaceId: r.workspace_id, category: 'approval',
      // Tighter window: an agent is blocked while this waits.
      dedupeKey: `approval:${bucket(30)}`,
      subject: t.subject, text: t.text, html: t.html,
    });
  }

  // ---- allowance running out ----------------------------------------------
  const { rows: usage } = await db.query<{
    id: string; plan: string; period_decisions: number; credit_micros: number;
  }>(
    `SELECT id, plan, period_decisions, credit_micros FROM workspaces WHERE status = 'active'`);
  const { PLANS } = await import('../domain/plans.js');
  for (const w of usage) {
    const plan = PLANS[w.plan as keyof typeof PLANS] ?? PLANS.free;
    const remaining = Math.max(0, plan.includedEffects - w.period_decisions);
    const ratio = remaining / plan.includedEffects;
    // Only two moments are worth an email: nearly out, and out.
    const stage = remaining === 0 ? 'exhausted' : ratio <= 0.1 ? 'low' : null;
    if (!stage) continue;
    const t = tpl.usageAlert(remaining, plan.includedEffects, w.credit_micros);
    await safeQueue({
      workspaceId: w.id, category: 'usage',
      // Once per stage per day: a monthly allowance does not need hourly nagging.
      dedupeKey: `usage:${stage}:${bucket(1440)}`,
      subject: t.subject, text: t.text, html: t.html,
    });
  }

  return queued;
}

export { tpl as emailTemplates };
export type { Category };
