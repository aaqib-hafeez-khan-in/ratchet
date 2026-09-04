// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { createHmac } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { getPool, withTx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { validateWebhookUrl, resolvePublicAddress, UnsafeUrlError } from '../lib/ssrf.js';

/**
 * Signed webhook delivery.
 *
 * Security properties:
 *  - The destination is re-validated and re-resolved on EVERY attempt, and the
 *    socket is pinned to the address we just checked, so a DNS rebind between
 *    check and connect cannot reach an internal host.
 *  - Redirects are never followed; a 3xx is a delivery failure.
 *  - The response body is read only up to a small cap and then discarded.
 *  - The signature covers timestamp + delivery id + body, so a receiver can
 *    reject both forgeries and replays.
 */

export interface DeliveryOutcome {
  delivered: boolean; status?: number; error?: string; retryable: boolean;
}

export function signPayload(secret: string, timestamp: number, deliveryId: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex');
}

function backoffMs(attempt: number): number {
  // Exponential with full jitter, capped at 30 minutes.
  const base = Math.min(30 * 60_000, 1000 * 2 ** attempt);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

async function post(url: URL, body: string, headers: Record<string, string>): Promise<DeliveryOutcome> {
  let pinned;
  try {
    validateWebhookUrl(url.toString());
    pinned = await resolvePublicAddress(url);
  } catch (err) {
    // A destination that is no longer safe is a permanent failure, not a retry.
    return {
      delivered: false, retryable: false,
      error: err instanceof UnsafeUrlError ? `unsafe destination: ${err.reason}` : 'destination check failed',
    };
  }

  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<DeliveryOutcome>((resolve) => {
    let settled = false;
    const done = (o: DeliveryOutcome) => { if (!settled) { settled = true; resolve(o); } };

    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'Ratchet-Webhooks/1.0',
        host: url.host,
      },
      // Pin the socket to the address we just validated. This is the second
      // half of the SSRF defence: a DNS rebind after the check cannot move us.
      lookup: (_hostname: string, _opts: unknown, cb: (e: Error | null, a: string, f: number) => void) =>
        cb(null, pinned.address, pinned.family),
      // SNI and certificate validation still use the real hostname.
      ...(isHttps ? { servername: pinned.host, rejectUnauthorized: true } : {}),
      timeout: config.webhook.timeoutMs,
    } as https.RequestOptions, (res) => {
      const status = res.statusCode ?? 0;
      // Read a bounded amount, then discard. Node never follows redirects.
      let read = 0;
      res.on('data', (chunk: Buffer) => {
        read += chunk.length;
        if (read > config.webhook.maxResponseBytes) res.destroy();
      });
      const finish = () => {
        if (status >= 200 && status < 300) {
          done({ delivered: true, status, retryable: false });
        } else if (status >= 300 && status < 400) {
          done({ delivered: false, status, retryable: false, error: 'redirects are not followed' });
        } else {
          // A 4xx means the receiver rejected the event and a retry will not
          // help; 5xx and throttling are worth another attempt.
          const retryable = status >= 500 || status === 408 || status === 429;
          done({ delivered: false, status, retryable, error: `receiver returned ${status}` });
        }
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });

    req.on('timeout', () => {
      req.destroy();
      done({ delivered: false, retryable: true, error: 'timed out' });
    });
    req.on('error', (err: Error) => {
      done({ delivered: false, retryable: true, error: err.message.slice(0, 200) });
    });
    req.end(body);
  });
}

/** Deliver one batch of due webhooks. Returns how many were attempted. */
export async function deliverDue(batchSize = 20): Promise<number> {
  const claimed = await withTx(async (tx) => {
    const { rows } = await tx.query<{
      id: string; endpoint_id: string; payload: any; attempts: number;
      url: string; secret: string;
    }>(
      `SELECT d.id, d.endpoint_id, d.payload, d.attempts, e.url, e.secret
         FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.state = 'queued' AND d.next_attempt_at <= now()
          AND e.disabled_at IS NULL
        ORDER BY d.next_attempt_at
        LIMIT $1
        FOR UPDATE OF d SKIP LOCKED`,
      [batchSize],
    );
    if (rows.length === 0) return [];
    await tx.query(
      `UPDATE webhook_deliveries SET state='delivering', attempts = attempts + 1
        WHERE id = ANY($1::text[])`,
      [rows.map((r) => r.id)],
    );
    return rows;
  });

  for (const d of claimed) {
    const body = typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    const signature = signPayload(d.secret, ts, d.id, body);
    const outcome = await post(new URL(d.url), body, {
      'ratchet-delivery-id': d.id,
      'ratchet-timestamp': String(ts),
      'ratchet-signature': `t=${ts},v1=${signature}`,
      'idempotency-key': d.id,
    });

    const attempts = d.attempts + 1;
    if (outcome.delivered) {
      await getPool().query(
        `UPDATE webhook_deliveries
            SET state='delivered', delivered_at=now(), last_status=$2, last_error=NULL
          WHERE id=$1`,
        [d.id, outcome.status ?? null],
      );
    } else if (!outcome.retryable || attempts >= config.webhook.maxAttempts) {
      await getPool().query(
        `UPDATE webhook_deliveries SET state='dead', last_status=$2, last_error=$3 WHERE id=$1`,
        [d.id, outcome.status ?? null, outcome.error ?? 'delivery failed'],
      );
    } else {
      await getPool().query(
        `UPDATE webhook_deliveries
            SET state='queued', next_attempt_at = now() + ($2 || ' milliseconds')::interval,
                last_status=$3, last_error=$4
          WHERE id=$1`,
        [d.id, String(backoffMs(attempts)), outcome.status ?? null, outcome.error ?? null],
      );
    }
  }
  return claimed.length;
}

