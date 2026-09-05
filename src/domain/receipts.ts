// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
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

export const RECEIPT_VERSION = 'ratchet-receipt-v3';

/**
 * Ed25519 keypair derived deterministically from AUTH_SECRET.
 *
 * Node needs a PKCS#8 wrapper around the raw 32-byte seed; the prefix below is
 * the fixed ASN.1 header for an Ed25519 private key, so the only variable part
 * is the seed itself.
 */
let cached: { priv: ReturnType<typeof createPrivateKey>; pubB64: string; kid: string } | null = null;

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
  const pubB64 = pubDer.subarray(12).toString('base64');
  // The id is a fingerprint of the public key, so it is stable, derivable by
  // anyone holding the key, and reveals nothing.
  const kid = createHash('sha256').update(pubDer.subarray(12)).digest('hex').slice(0, 16);
  cached = { priv, pubB64, kid };
  return cached;
}

/** Identifier for the key currently signing. */
export function currentKid(): string {
  return keypair().kid;
}

/**
 * Record the public half of the current key so receipts signed with it stay
 * verifiable after AUTH_SECRET is rotated away from it.
 *
 * A public key is not a secret, which is the whole reason rotation can work at
 * all: we keep publishing old public keys forever while losing the ability to
 * sign with them.
 */
export async function registerCurrentKey(): Promise<void> {
  const { kid, pubB64 } = keypair();
  await getPool().query(
    `INSERT INTO receipt_keys (kid, public_key) VALUES ($1,$2)
     ON CONFLICT (kid) DO UPDATE SET last_seen_at = now()`,
    [kid, pubB64],
  );
}

/** Every key we have ever signed with, so any receipt can still be verified. */
export async function knownKeys(): Promise<
  Array<{ kid: string; public_key: string; algorithm: string; current: boolean }>> {
  const { rows } = await getPool().query<{ kid: string; public_key: string; algorithm: string }>(
    `SELECT kid, public_key, algorithm FROM receipt_keys ORDER BY first_seen_at ASC`);
  const now = currentKid();
  return rows.map((r) => ({ ...r, current: r.kid === now }));
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
  /** What the caller declared this effect would cost, in micro-USD. */
  cost_micros: number;
  /** Which key signed this. Inside the signature, so it cannot be repointed. */
  kid: string;
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
export type ReceiptInput = Omit<ReceiptBody, 'kid'>;

export async function writeReceipt(tx: PoolClient, input: ReceiptInput): Promise<void> {
  // The caller should not have to know which key is current; that is our
  // bookkeeping, and getting it wrong would be silent.
  const body: ReceiptBody = { ...input, kid: currentKid() };
  const signed = signBody(body);
  await tx.query(
    `INSERT INTO receipts
       (workspace_id, effect_id, decision, attempt, body, signature, body_hash, cost_micros, kid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [body.workspace_id, body.effect_id, body.decision, body.attempt,
     signed.body, signed.signature, signed.hash, body.cost_micros, body.kid],
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

/**
 * Prune receipts older than the retention window, preserving verifiability.
 *
 * The order matters and is the whole design: CHECKPOINT FIRST, then delete.
 * A checkpoint is a signed statement that the chain ran unbroken up to seq N
 * and ended at hash H. The audit resumes from there, so a pruned gap does not
 * read as tampering.
 *
 * Doing it the other way round — delete then attest — would mean a crash
 * between the two steps leaves a broken chain with nothing explaining it, and
 * the customer's audit fails with no way to tell truncation from an attack.
 * Both steps run in one transaction for the same reason.
 *
 * What is lost is stated plainly: a pruned receipt cannot be re-verified
 * individually afterwards. The checkpoint attests that the chain was intact
 * when we signed it, not that any particular removed receipt said what someone
 * later claims. A customer needing more must keep their own copies.
 */
export async function pruneReceipts(
  retentionDays: number, batch = 1000,
): Promise<{ pruned: number; checkpoints: number }> {
  const pool = getPool();
  const { rows: workspaces } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM receipts
      WHERE created_at < now() - make_interval(days => $1) AND seq IS NOT NULL
      LIMIT 50`, [retentionDays]);

  let pruned = 0;
  let checkpoints = 0;
  for (const { workspace_id } of workspaces) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The boundary: the highest chained seq old enough to remove. Unchained
      // receipts are never pruned — they are not yet attested by anything.
      const { rows: edge } = await client.query<{ seq: string; chain_hash: string; n: string }>(
        `SELECT max(seq)::text AS seq,
                (array_agg(chain_hash ORDER BY seq DESC))[1] AS chain_hash,
                count(*)::text AS n
           FROM (SELECT seq, chain_hash FROM receipts
                  WHERE workspace_id = $1 AND seq IS NOT NULL
                    AND created_at < now() - make_interval(days => $2)
                  ORDER BY seq ASC LIMIT $3) t`,
        [workspace_id, retentionDays, batch]);

      const upTo = edge[0]?.seq ? Number(edge[0].seq) : 0;
      const count = edge[0]?.n ? Number(edge[0].n) : 0;
      if (!upTo || !count || !edge[0]?.chain_hash) {
        await client.query('ROLLBACK');
        continue;
      }

      const body = {
        v: 'ratchet-checkpoint-v2',
        kid: currentKid(),
        workspace_id,
        up_to_seq: upTo,
        chain_hash: edge[0].chain_hash,
        pruned_count: count,
        signed_at: new Date().toISOString(),
      };
      const canonical = JSON.stringify(
        Object.fromEntries(Object.keys(body).sort().map((k) => [k, (body as never)[k]])));
      const signature = edSign(null, Buffer.from(canonical), keypair().priv).toString('base64');

      await client.query(
        `INSERT INTO receipt_checkpoints
           (workspace_id, up_to_seq, chain_hash, pruned_count, body, signature, kid)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [workspace_id, upTo, edge[0].chain_hash, count, canonical, signature, currentKid()]);

      const del = await client.query(
        `DELETE FROM receipts WHERE workspace_id = $1 AND seq IS NOT NULL AND seq <= $2`,
        [workspace_id, upTo]);

      await client.query('COMMIT');
      pruned += del.rowCount ?? 0;
      checkpoints += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return { pruned, checkpoints };
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
): Promise<{ checked: number; ok: boolean; brokenAtSeq?: number; reason?: string;
             prunedThroughSeq?: number }> {
  const keys = new Map((await knownKeys().catch(() => [])).map((k) => [k.kid, k.public_key]));
  // The key we are signing with right now is always usable, whether or not the
  // registry write has landed. The fallback is deliberately narrow: an unknown
  // kid that is NOT the current key still fails, because that is the case where
  // someone is pointing a receipt at a key nobody ever published.
  keys.set(currentKid(), receiptPublicKey());

  // Resume from the newest checkpoint if the log has been pruned. Starting at
  // seq 1 unconditionally would report a truncated log as tampered, which is
  // the failure that would make every long-lived customer distrust the audit.
  const { rows: cp } = await db.query<{
    up_to_seq: string; chain_hash: string; body: string; signature: string;
  }>(`SELECT up_to_seq, chain_hash, body, signature FROM receipt_checkpoints
       WHERE workspace_id=$1 ORDER BY up_to_seq DESC LIMIT 1`, [workspaceId]);

  let startAfter = 0;
  let prev: string | null = null;
  let prunedTo: number | null = null;
  if (cp[0]) {
    // The checkpoint is itself signed, so a forged one cannot be used to hide a
    // gap: verify it before trusting the hash it hands us.
    const cpKid = (JSON.parse(cp[0].body) as { kid?: string }).kid;
    if (!verifyReceipt(cp[0].body, cp[0].signature, cpKid ? keys.get(cpKid) : undefined)) {
      return { checked: 0, ok: false, reason: 'the pruning checkpoint does not verify' };
    }
    startAfter = Number(cp[0].up_to_seq);
    prev = cp[0].chain_hash;
    prunedTo = startAfter;
  }

  const { rows } = await db.query<{
    seq: string; body: string; signature: string; body_hash: string;
    prev_hash: string | null; chain_hash: string;
  }>(`SELECT seq, body, signature, body_hash, prev_hash, chain_hash
        FROM receipts WHERE workspace_id=$1 AND seq IS NOT NULL AND seq > $3
        ORDER BY seq ASC LIMIT $2`, [workspaceId, limit, startAfter]);

  let checked = 0;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (createHash('sha256').update(r.body).digest('hex') !== r.body_hash) {
      return { checked, ok: false, brokenAtSeq: seq, reason: 'body does not match its hash' };
    }
    // Against the key named in the receipt, not whichever key is current.
    // Verifying everything with the current key is precisely what made rotation
    // destroy the whole history.
    const kid = (JSON.parse(r.body) as { kid?: string }).kid;
    const pub = kid ? keys.get(kid) : undefined;
    if (kid && !pub) {
      return { checked, ok: false, brokenAtSeq: seq,
               reason: `signed by unknown key ${kid}` };
    }
    if (!verifyReceipt(r.body, r.signature, pub)) {
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
  return { checked, ok: true, ...(prunedTo ? { prunedThroughSeq: prunedTo } : {}) };
}
