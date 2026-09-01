import { stricterThan } from '../rate-limit.js';
/**
 * Receipts, chain audit, and reconciliation.
 *
 * These exist so a customer never has to take our word for anything. The
 * receipt proves we made a decision; the chain audit proves we did not quietly
 * drop one; reconciliation proves their own system actually asked us before
 * acting, which is the failure we cannot see from here.
 */
import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { config } from '../../lib/config.js';
import { wsOf } from '../plugins/auth.js';
import { receiptsFor, auditChain, receiptPublicKey, currentKid, knownKeys,
         RECEIPT_VERSION } from '../../domain/receipts.js';
import { errorResponses } from '../schemas.js';

/**
 * Registered at the ORIGIN root, not under /v1.
 *
 * RFC 8615 defines .well-known as living at the root of an origin. Mounted
 * under a version prefix it is not a well-known URI, just a path shaped like
 * one, and nothing looking for it would find it. The site links to it directly,
 * so the link test catches this if it ever moves again.
 */
export async function receiptWellKnown(app: FastifyInstance) {
  app.get('/.well-known/ratchet-receipt-key', { schema: { hide: true } }, async (_req, reply) => {
    // Every key we have ever signed with, not only the current one. A receipt
    // names its key in `kid`; look that up here. Publishing only the current
    // key is what made rotation destroy the verifiability of all history.
    const keys = await knownKeys().catch(() => []);
    return reply.type('application/json; charset=utf-8').send({
      version: RECEIPT_VERSION,
      algorithm: 'ed25519',
      current_kid: currentKid(),
      public_key: receiptPublicKey(),
      keys: keys.length ? keys : [{ kid: currentKid(), public_key: receiptPublicKey(),
                                    algorithm: 'ed25519', current: true }],
      encoding: 'base64 raw 32-byte public key; signature is base64 over the exact `body` bytes',
      verify: 'Find the receipt\'s `kid`, take the matching public_key from `keys`, then '
        + 'ed25519_verify(public_key, body_bytes, signature).',
      note: 'Retired keys stay published forever so old receipts remain verifiable. We keep '
        + 'the public half only; we cannot sign with a retired key, which is what rotation '
        + 'is for.',
    });
  });
}

export default async function receiptRoutes(app: FastifyInstance) {
  app.get('/effects/:effectId/receipts', {
    preHandler: app.requireConsole('effects:read'),
    schema: {
      tags: ['Receipts'], operationId: 'effectReceipts',
      summary: 'Signed receipts for every decision on one effect',
      description:
        'One receipt per decision, in order. `signature` is over the exact bytes in `body`, '
        + 'verifiable offline against /.well-known/ratchet-receipt-key. `chained` is false '
        + 'for a receipt the worker has not yet linked; that affects only tamper-evidence '
        + 'for the log as a whole, not the signature.',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const effectId = (req.params as { effectId: string }).effectId;
    const rows = await receiptsFor(getPool(), wsOf(req), effectId);
    return {
      effect_id: effectId,
      public_key_url: `${config.publicUrl.replace(/\/+$/, '')}/.well-known/ratchet-receipt-key`,
      receipts: rows.map((r) => ({
        seq: r.seq, decision: r.decision, attempt: r.attempt,
        body: r.body, signature: r.signature, body_hash: r.bodyHash,
        prev_hash: r.prevHash, chain_hash: r.chainHash, chained: r.chained,
      })),
    };
  });

  /**
   * Recompute this workspace's whole chain from the stored bytes.
   *
   * Deliberately trusts none of its own columns: it rehashes each body, checks
   * each signature, and walks the links. This is the check a customer runs
   * against us, so it has to be able to fail.
   */
  app.get('/receipts/audit', {
    preHandler: app.requireConsole('effects:read'),
    schema: {
      tags: ['Receipts'], operationId: 'auditReceipts',
      summary: 'Verify the receipt chain end to end',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const r = await auditChain(getPool(), wsOf(req));
    return {
      ...r,
      meaning: r.ok
        ? 'Every receipt verifies and the chain is continuous. No decision was altered or removed.'
        : 'The chain does not verify. Treat the audit trail as untrustworthy and tell us.',
    };
  });

  /**
   * What the gate actually saved.
   *
   * A gate's work is invisible: the duplicate charge that did not happen leaves
   * no trace anywhere except here. Every decision that refused a repeat, on an
   * effect that declared a cost, is money that would otherwise have been spent
   * twice.
   *
   * The number is deliberately conservative. It counts only refusals where the
   * caller told us the cost up front, so it under-reports rather than flatters,
   * and it counts money NOT SPENT AT VENDORS — never our own revenue.
   */
  app.get('/usage/prevented', {
    preHandler: app.requireConsole('effects:read'),
    schema: {
      tags: ['Receipts'], operationId: 'preventedLoss',
      summary: 'Duplicate actions refused, and what they would have cost',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const workspaceId = wsOf(req);
    const { rows } = await getPool().query<{
      decision: string; n: string; micros: string | null;
    }>(
      `SELECT r.decision,
              count(*)::text AS n,
              COALESCE(sum(r.cost_micros), 0)::text AS micros
         FROM receipts r
        WHERE r.workspace_id = $1
          AND r.decision IN ('duplicate','in_flight','blocked')
          AND r.created_at > now() - interval '30 days'
        GROUP BY r.decision`,
      [workspaceId],
    );

    const by = Object.fromEntries(rows.map((r) => [r.decision, {
      count: Number(r.n), would_have_cost_micros: Number(r.micros ?? 0),
    }]));
    const refused = rows.reduce((a, r) => a + Number(r.n), 0);
    const micros = rows.reduce((a, r) => a + Number(r.micros ?? 0), 0);

    return {
      window: '30 days',
      duplicate_actions_refused: refused,
      would_have_cost_micros: micros,
      would_have_cost_usd: (micros / 1e6).toFixed(2),
      by_decision: by,
      note: 'Counts only refusals on effects that declared a cost, so the real figure is '
        + 'at least this. This is money not spent at your vendors, not money paid to us.',
    };
  });

  /**
   * Reconciliation: which of these real-world actions went through the gate?
   *
   * The gate is advisory, so the failure it cannot see is a path in the
   * customer's own system that never called us at all. They post the references
   * their vendor recorded, and we say which ones we authorised. Anything we do
   * not recognise is an ungated path, which is usually a bug they did not know
   * they had.
   *
   * They send references, never credentials: we hold no vendor access and this
   * does not change that.
   */
  app.post('/reconcile', {
    preHandler: app.requireConsole('effects:read'),
    config: { rateLimit: stricterThan(60, '1 hour') },
    schema: {
      tags: ['Receipts'], operationId: 'reconcile',
      summary: 'Find real-world actions that bypassed the gate',
      description:
        'Post the idempotency keys (or vendor references you recorded in `result`) for '
        + 'actions your vendor says happened. Returns which ones Ratchet authorised and '
        + 'which it has never seen. The unmatched ones are paths in your system that did '
        + 'not ask before acting.',
      body: {
        type: 'object', required: ['effect_type', 'keys'], additionalProperties: false,
        properties: {
          effect_type: { type: 'string', maxLength: 64 },
          keys: {
            type: 'array', minItems: 1, maxItems: 1000,
            items: { type: 'string', maxLength: 255 },
            description: 'The idempotency keys your system should have used.',
          },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const b = req.body as { effect_type: string; keys: string[] };
    const workspaceId = wsOf(req);
    // Normalised the same way the gate normalises, or a Mac-encoded key would
    // look ungated when it was in fact gated.
    const { normalizeText } = await import('../../lib/ids.js');
    const wanted = [...new Set(b.keys.map(normalizeText))];

    const { rows } = await getPool().query<{ idempotency_key: string; state: string }>(
      `SELECT idempotency_key, state FROM effects
        WHERE workspace_id = $1 AND effect_type = $2 AND idempotency_key = ANY($3)`,
      [workspaceId, b.effect_type, wanted],
    );
    const seen = new Map(rows.map((r) => [r.idempotency_key, r.state]));
    const ungated = wanted.filter((k) => !seen.has(k));

    return {
      effect_type: b.effect_type,
      checked: wanted.length,
      gated: seen.size,
      ungated: ungated.length,
      ungated_keys: ungated.slice(0, 100),
      meaning: ungated.length === 0
        ? 'Every action you listed went through the gate.'
        : `${ungated.length} action(s) reached the vendor without ever asking Ratchet. `
          + 'Those code paths are unprotected: a retry there can act twice.',
    };
  });
}
