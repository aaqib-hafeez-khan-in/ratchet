// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { getPool } from '../db/pool.js';
import { config } from '../lib/config.js';
import { creditConfirmedPayment, expireStaleIntents, listAssets } from '../domain/crypto.js';

/**
 * Solana chain watcher.
 *
 * Reads the operator's receiving address for incoming SPL transfers, matches
 * them to open payment intents by memo, and credits the ledger. It only ever
 * READS the chain — there is no key here and no ability to move anything.
 *
 * Correctness rests on two things already built:
 *  - The transaction signature is globally unique on-chain and is used as the
 *    ledger dedupe key, so re-reading the same block credits nothing twice.
 *  - Crediting itself is a single transaction that also settles the intent, so
 *    a crash between the two is impossible.
 *
 * This means the watcher can be as dumb as it likes: at-least-once observation
 * is enough, because the crediting side is idempotent. That is the whole reason
 * to put the idempotency at the ledger rather than in the poller.
 */

const RPC_TIMEOUT_MS = 12_000;

interface RpcResult<T> { result?: T; error?: { code: number; message: string } }

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.crypto.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC ${method} returned HTTP ${res.status}`);
  const body = (await res.json()) as RpcResult<T>;
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as T;
}

/** Pull the memo out of a transaction's log messages. */
function memoFrom(logs: string[] | null | undefined): string | null {
  if (!logs) return null;
  for (const line of logs) {
    // Memo program logs look like: 'Program log: Memo (len 17): "ratchet-abc123"'
    const m = /Memo \(len \d+\): "([^"]+)"/.exec(line);
    if (m?.[1]?.startsWith('ratchet-')) return m[1];
  }
  return null;
}

/**
 * Total moved to `destination` for `mint` in one transaction, in base units.
 *
 * Derived from the pre/post token balance deltas rather than by parsing
 * instructions: a transfer can be split across several instructions, and the
 * balance delta is the amount that actually landed.
 */
function amountReceived(tx: any, destinationOwner: string, mint: string): bigint {
  const pre = tx?.meta?.preTokenBalances ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];
  const key = (b: any) => `${b.accountIndex}`;
  const before = new Map<string, bigint>();
  for (const b of pre) {
    if (b.mint === mint && b.owner === destinationOwner) {
      before.set(key(b), BigInt(b.uiTokenAmount?.amount ?? '0'));
    }
  }
  let delta = 0n;
  for (const b of post) {
    if (b.mint === mint && b.owner === destinationOwner) {
      delta += BigInt(b.uiTokenAmount?.amount ?? '0') - (before.get(key(b)) ?? 0n);
    }
  }
  return delta > 0n ? delta : 0n;
}

export interface WatchResult { scanned: number; credited: number; skipped: number; }

/**
 * One pass: fetch recent signatures for the destination, inspect any that carry
 * a Ratchet memo matching an open intent, and credit those that confirm.
 */
export async function watchChainOnce(limit = 25): Promise<WatchResult> {
  const out: WatchResult = { scanned: 0, credited: 0, skipped: 0 };
  if (!config.crypto.solanaDestination || !config.crypto.rpcUrl) return out;

  // Only look while something is actually owed. With no open intent there is
  // nothing a transfer could be attributed to, so skip the RPC entirely.
  const { rows: open } = await getPool().query<{ memo: string; token_mint: string }>(
    `SELECT memo, token_mint FROM crypto_intents
      WHERE state IN ('awaiting_payment','confirming') AND expires_at > now() - interval '1 day'`);
  if (open.length === 0) return out;
  const wanted = new Map(open.map((r) => [r.memo, r.token_mint]));

  const assets = await listAssets(getPool(), true);
  const confirmationsFor = new Map(assets.map((a) => [a.tokenMint, a.requiredConfirmations]));

  const sigs = await rpc<Array<{ signature: string; err: unknown; confirmationStatus?: string }>>(
    'getSignaturesForAddress', [config.crypto.solanaDestination, { limit }]);

  for (const s of sigs) {
    out.scanned++;
    // A failed transaction moved nothing.
    if (s.err) { out.skipped++; continue; }

    const tx = await rpc<any>('getTransaction', [
      s.signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!tx) { out.skipped++; continue; }

    const memo = memoFrom(tx?.meta?.logMessages);
    if (!memo || !wanted.has(memo)) { out.skipped++; continue; }

    const mint = wanted.get(memo)!;
    const amount = amountReceived(tx, config.crypto.solanaDestination, mint);
    if (amount <= 0n) { out.skipped++; continue; }

    // `confirmed` is one confirmation; `finalized` is effectively many.
    const confirmations = s.confirmationStatus === 'finalized' ? 32
      : s.confirmationStatus === 'confirmed' ? 1 : 0;
    if (confirmations < (confirmationsFor.get(mint) ?? 1)) { out.skipped++; continue; }

    // Idempotent on the signature, so re-observing this transfer is harmless.
    const r = await creditConfirmedPayment({
      memo, txSignature: s.signature, observedAmount: amount, confirmations,
    });
    if (r.credited) out.credited++;
    else out.skipped++;
  }

  return out;
}

/** Housekeeping: quotes that were never paid should not linger. */
export async function expireQuotes(): Promise<number> {
  return expireStaleIntents();
}
