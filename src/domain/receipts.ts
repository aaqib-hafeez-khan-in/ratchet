/**
 * Signed decision receipts.
 *
 * Every product in this category asks you to take its word for it. The evidence
 * that a gate worked is an absence — the charge that did not happen — and an
 * absence cannot be audited. A receipt turns each decision into something the
 * customer can check themselves, offline, against a key we publish.
 *
 * Two properties, deliberately separated because they have different costs:
 *
 *   AUTHORSHIP is proved synchronously. Each receipt is signed the moment the
 *   decision is made. Signing is cheap and needs no lock, so it does not touch
 *   the contention the concurrency work exists to avoid.
 *
 *   COMPLETENESS is proved afterwards. The worker links receipts into a
 *   per-workspace hash chain. A signature alone proves we wrote a receipt; the
 *   chain proves we did not later remove one. Building it inline would need an
 *   exclusive workspace lock on every decision, including the duplicates and
 *   retries that currently skip that lock entirely.
 *
 * The signing key is derived from AUTH_SECRET rather than configured
 * separately, so there is no second secret to lose. The consequence is stated
 * plainly in the docs: rotating AUTH_SECRET rotates the receipt key, and
 * receipts signed under the old one verify only against the old public key.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, hkdfSync } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, type Db } from '../db/pool.js';
import { config } from '../lib/config.js';

export const RECEIPT_VERSION = 'ratchet-receipt-v1';

/**
 * Ed25519 keypair derived deterministically from AUTH_SECRET.
 *
 * Node needs a PKCS#8 wrapper around the raw 32-byte seed; the prefix below is
 * the fixed ASN.1 header for an Ed25519 private key, so the only variable part
 * is the seed itself.
 */
let cached: { priv: ReturnType<typeof createPrivateKey>; pubB64: string } | null = null;

function keypair() {
  if (cached) return cached;
  const seed = Buffer.from(hkdfSync('sha256', Buffer.from(config.authSecret),
    Buffer.alloc(0), Buffer.from('ratchet-receipt-signing-v1'), 32));
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  // Strip the 12-byte SPKI header to expose the raw 32-byte public key.
  cached = { priv, pubB64: pubDer.subarray(12).toString('base64') };
  return cached;
}

/** The public half, for anyone verifying a receipt without asking us. */
export function receiptPublicKey(): string {
  return keypair().pubB64;
}

export interface ReceiptBody {
  v: string;
  workspace_id: string;
  effect_id: string;
  effect_type: string;
  idempotency_key: string;
  decision: string;
  state: string;
  attempt: number;
  payload_fingerprint: string;
  decided_at: string;
}

/**
 * Canonical JSON: keys in sorted order, no incidental whitespace.
 *
 * A verifier must be able to reproduce the exact bytes we signed. We also store
 * those bytes verbatim, so verification never depends on two implementations
 * serialising identically — but a stable form makes an independent
 * implementation possible at all.
 */
export function canonicalBody(b: ReceiptBody): string {
  const keys = Object.keys(b).sort() as (keyof ReceiptBody)[];
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, b[k]])));
}

export function signBody(body: ReceiptBody): { body: string; signature: string; hash: string } {
  const canonical = canonicalBody(body);
  const signature = edSign(null, Buffer.from(canonical), keypair().priv).toString('base64');
  const hash = createHash('sha256').update(canonical).digest('hex');
  return { body: canonical, signature, hash };
}

/** Verify a receipt exactly as an outside party would. */
export function verifyReceipt(bodyJson: string, signatureB64: string, publicKeyB64?: string): boolean {
  const raw = Buffer.from(publicKeyB64 ?? receiptPublicKey(), 'base64');
  if (raw.length !== 32) return false;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  try {
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(bodyJson), pub, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Record a receipt for one decision.
 *
 * Runs inside the caller's transaction so a decision and its receipt cannot
 * disagree: if the decision rolls back, so does the evidence for it.
 */
export async function writeReceipt(tx: PoolClient, body: ReceiptBody): Promise<void> {
  const signed = signBody(body);
  await tx.query(
    `INSERT INTO receipts
       (workspace_id, effect_id, decision, attempt, body, signature, body_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [body.workspace_id, body.effect_id, body.decision, body.attempt,
     signed.body, signed.signature, signed.hash],
  );
}

/**
 * Link signed receipts into each workspace's hash chain.
 *
 * Claims with FOR UPDATE SKIP LOCKED so replicas never chain the same rows
 * twice, and processes one workspace at a time because a chain is inherently
 * ordered.
 */
export async function chainPendingReceipts(batch = 500): Promise<number> {
  const pool = getPool();
  const { rows: pending } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM receipts WHERE seq IS NULL LIMIT 50`);

  let linked = 0;
  for (const { workspace_id } of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One chainer per workspace at a time; another replica simply moves on.
      const head = await client.query<{ last_seq: string; last_hash: string | null }>(
        `INSERT INTO receipt_chains (workspace_id) VALUES ($1)
         ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
         RETURNING last_seq, last_hash`, [workspace_id]);

      const { rows } = await client.query<{ id: string; body_hash: string }>(
        `SELECT id, body_hash FROM receipts
          WHERE workspace_id = $1 AND seq IS NULL
          ORDER BY id ASC LIMIT $2 FOR UPDATE SKIP LOCKED`, [workspace_id, batch]);
      if (!rows.length) { await client.query('ROLLBACK'); continue; }

      let seq = Number(head.rows[0]!.last_seq);
      let prev = head.rows[0]!.last_hash;
      for (const r of rows) {
        seq += 1;
        // Each link commits to the one before it, so removing or reordering a
        // receipt invalidates every hash after it.
        const chainHash = createHash('sha256')
          .update(`${prev ?? ''}|${seq}|${r.body_hash}`).digest('hex');
        await client.query(
          `UPDATE receipts SET seq=$2, prev_hash=$3, chain_hash=$4, chained_at=now()
            WHERE id=$1`, [r.id, seq, prev, chainHash]);
        prev = chainHash;
        linked += 1;
      }
      await client.query(
        `UPDATE receipt_chains SET last_seq=$2, last_hash=$3, updated_at=now()
          WHERE workspace_id=$1`, [workspace_id, seq, prev]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return linked;
}

export interface ReceiptView {
  seq: number | null;
  effectId: string;
  decision: string;
  attempt: number;
  body: unknown;
  signature: string;
  bodyHash: string;
  prevHash: string | null;
  chainHash: string | null;
  chained: boolean;
}

export async function receiptsFor(
  db: Db, workspaceId: string, effectId: string,
): Promise<ReceiptView[]> {
  const { rows } = await db.query<{
    seq: string | null; effect_id: string; decision: string; attempt: number;
    body: string; signature: string; body_hash: string;
    prev_hash: string | null; chain_hash: string | null;
  }>(`SELECT seq, effect_id, decision, attempt, body, signature, body_hash, prev_hash, chain_hash
        FROM receipts WHERE workspace_id = $1 AND effect_id = $2 ORDER BY id ASC`,
     [workspaceId, effectId]);
  return rows.map((r) => ({
    seq: r.seq === null ? null : Number(r.seq),
    effectId: r.effect_id,
    decision: r.decision,
    attempt: r.attempt,
    body: JSON.parse(r.body),
    signature: r.signature,
    bodyHash: r.body_hash,
    prevHash: r.prev_hash,
    chainHash: r.chain_hash,
    chained: r.seq !== null,
  }));
}

/**
 * Walk a workspace's chain and report the first place it breaks.
 *
 * This is the check a customer runs against us, so it recomputes every hash
 * from the stored bytes rather than trusting any column we wrote.
 */
export async function auditChain(
  db: Db, workspaceId: string, limit = 10_000,
): Promise<{ checked: number; ok: boolean; brokenAtSeq?: number; reason?: string }> {
  const { rows } = await db.query<{
    seq: string; body: string; signature: string; body_hash: string;
    prev_hash: string | null; chain_hash: string;
  }>(`SELECT seq, body, signature, body_hash, prev_hash, chain_hash
        FROM receipts WHERE workspace_id=$1 AND seq IS NOT NULL
        ORDER BY seq ASC LIMIT $2`, [workspaceId, limit]);

  let prev: string | null = null;
  let checked = 0;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (createHash('sha256').update(r.body).digest('hex') !== r.body_hash) {
      return { checked, ok: false, brokenAtSeq: seq, reason: 'body does not match its hash' };
    }
    if (!verifyReceipt(r.body, r.signature)) {
      return { checked, ok: false, brokenAtSeq: seq, reason: 'signature does not verify' };
    }
    if ((r.prev_hash ?? null) !== prev) {
      return { checked, ok: false, brokenAtSeq: seq, reason: 'chain is discontinuous — a receipt was removed or reordered' };
    }
    const expect: string = createHash('sha256').update(`${prev ?? ''}|${seq}|${r.body_hash}`).digest('hex');
    if (expect !== r.chain_hash) {
      return { checked, ok: false, brokenAtSeq: seq, reason: 'chain hash does not match' };
    }
    prev = r.chain_hash;
    checked += 1;
  }
  return { checked, ok: true };
}
