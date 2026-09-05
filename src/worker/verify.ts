// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { config } from '../lib/config.js';

/**
 * On-chain verification for chains without a memo.
 *
 * The payer sends funds, then submits the transaction hash. This module reads
 * that transaction and answers one question: did exactly this amount of exactly
 * this asset actually arrive at our address, with enough confirmations?
 *
 * It reads only. There is no key here and nothing it can move.
 *
 * Everything is checked rather than assumed, because each unchecked field is a
 * way to be paid nothing and credit someone anyway:
 *  - the transaction succeeded (a reverted transfer moved nothing)
 *  - the recipient is OUR address, not merely some address
 *  - the asset is the one quoted, not a worthless token with the same name
 *  - the amount is what the transfer actually moved
 *  - confirmations meet the asset's threshold
 */

const TIMEOUT_MS = 12_000;

export interface Verified {
  ok: boolean;
  reason?: string;
  amount?: bigint;
  confirmations?: number;
}

async function json(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * JSON-RPC with failover across endpoints.
 *
 * Free public nodes rate-limit, return 403 under load, and disappear. Verifying
 * money against a single one means a payment silently fails to confirm because
 * somebody else exhausted a shared quota. Endpoints are tried in order and the
 * first that answers wins; only if every one fails does the caller see an
 * error, and then it says so rather than pretending the transfer was invalid.
 */
async function rpc(urls: string[], method: string, params: unknown[]): Promise<any> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const d = await json(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (d.error) throw new Error(d.error.message);
      return d.result;
    } catch (err) {
      failures.push(`${new URL(url).host}: ${(err as Error).message}`);
    }
  }
  throw new Error(`all RPC endpoints failed for ${method} — ${failures.join('; ')}`);
}

/** Configured endpoint first, then public fallbacks. */
/**
 * Base is still verifiable here although it is no longer quotable.
 *
 * Migration 039 disabled its assets and the chain has no destination, so no new
 * Base intent can be created. This path stays because verification is about
 * transactions that already happened: a chain we stopped accepting is not a
 * chain whose history stops needing to be checkable.
 */
function endpointsFor(chain: 'ethereum' | 'base'): string[] {
  const configured = config.crypto.chains[chain]?.rpc;
  const fallbacks = chain === 'base'
    ? ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com']
    : ['https://ethereum.publicnode.com', 'https://eth.drpc.org', 'https://eth.llamarpc.com'];
  return [...new Set([configured, ...fallbacks].filter(Boolean) as string[])];
}

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 transfer topic. */
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const topicToAddress = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

/**
 * Verify an ERC-20 transfer on any EVM chain.
 *
 * Reads the Transfer LOG rather than the transaction's input data: a transfer
 * can be made by a contract, batched, or routed, and the emitted log is what
 * actually happened on the ledger. Decoding `input` would miss all of those.
 */
export async function verifyEvmTransfer(args: {
  chain: 'ethereum' | 'base';
  txHash: string;
  destination: string;
  contract: string;
  minConfirmations: number;
}): Promise<Verified> {
  const urls = endpointsFor(args.chain);
  if (urls.length === 0) return { ok: false, reason: 'no RPC configured for that chain' };

  const receipt = await rpc(urls, 'eth_getTransactionReceipt', [args.txHash]);
  if (!receipt) return { ok: false, reason: 'transaction not found (or not yet mined)' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'transaction reverted — nothing moved' };

  const head = Number(await rpc(urls, 'eth_blockNumber', []));
  const mined = Number(receipt.blockNumber);
  const confirmations = Math.max(0, head - mined + 1);
  if (confirmations < args.minConfirmations) {
    return { ok: false, reason: `only ${confirmations} confirmation(s), need ${args.minConfirmations}`, confirmations };
  }

  const dest = args.destination.toLowerCase();
  const contract = args.contract.toLowerCase();
  let total = 0n;

  for (const log of receipt.logs ?? []) {
    if ((log.address ?? '').toLowerCase() !== contract) continue;      // right asset
    if ((log.topics?.[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topicToAddress(log.topics?.[2] ?? '') !== dest) continue;      // right recipient
    total += BigInt(log.data);
  }

  return total > 0n
    ? { ok: true, amount: total, confirmations }
    : { ok: false, reason: 'no transfer of that asset to that address in this transaction', confirmations };
}

/**
 * Verify a NATIVE asset transfer on an EVM chain (ETH on Ethereum or Base).
 *
 * Different from an ERC-20 transfer in a way that matters: a native transfer
 * moves no token and emits no log, so the amount lives on the transaction
 * itself rather than in an event.
 *
 * Only DIRECT transfers are verified — `tx.to` is the destination and
 * `tx.value` is the amount. ETH forwarded by a contract arrives as an internal
 * transfer, which leaves no trace in the transaction or receipt and is visible
 * only through a tracing API most public nodes do not expose. Rather than
 * appear to check something it cannot, this reports the transfer as
 * unverifiable and says why.
 */
export async function verifyEvmNative(args: {
  chain: 'ethereum' | 'base';
  txHash: string;
  destination: string;
  minConfirmations: number;
}): Promise<Verified> {
  const urls = endpointsFor(args.chain);
  if (urls.length === 0) return { ok: false, reason: 'no RPC configured for that chain' };

  const tx = await rpc(urls, 'eth_getTransactionByHash', [args.txHash]);
  if (!tx) return { ok: false, reason: 'transaction not found (or not yet mined)' };

  // A transaction can exist and still have reverted, moving nothing.
  const receipt = await rpc(urls, 'eth_getTransactionReceipt', [args.txHash]);
  if (!receipt) return { ok: false, reason: 'transaction not yet mined' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'transaction reverted — nothing moved' };

  const head = Number(await rpc(urls, 'eth_blockNumber', []));
  const confirmations = Math.max(0, head - Number(receipt.blockNumber) + 1);
  if (confirmations < args.minConfirmations) {
    return { ok: false, reason: `only ${confirmations} confirmation(s), need ${args.minConfirmations}`, confirmations };
  }

  if ((tx.to ?? '').toLowerCase() !== args.destination.toLowerCase()) {
    return {
      ok: false, confirmations,
      reason: 'this transaction did not send directly to that address. ETH forwarded by a '
            + 'contract is an internal transfer and cannot be verified here — send directly '
            + 'from a wallet instead.',
    };
  }

  const value = BigInt(tx.value ?? '0x0');
  return value > 0n
    ? { ok: true, amount: value, confirmations }
    : { ok: false, reason: 'transaction sent no value', confirmations };
}

/**
 * Verify a Bitcoin payment. Sums every output paying our address, because a
 * wallet may legitimately split across outputs.
 */
export async function verifyBitcoinTransfer(args: {
  txHash: string;
  destination: string;
  minConfirmations: number;
}): Promise<Verified> {
  const api = config.crypto.chains.bitcoin?.rpc;
  if (!api) return { ok: false, reason: 'no Bitcoin API configured' };

  const tx = await json(`${api}/tx/${args.txHash}`).catch(() => null);
  if (!tx) return { ok: false, reason: 'transaction not found' };

  let confirmations = 0;
  if (tx.status?.confirmed && typeof tx.status.block_height === 'number') {
    const tip = Number(await json(`${api}/blocks/tip/height`));
    confirmations = Math.max(0, tip - tx.status.block_height + 1);
  }
  if (confirmations < args.minConfirmations) {
    return { ok: false, reason: `only ${confirmations} confirmation(s), need ${args.minConfirmations}`, confirmations };
  }

  let sats = 0n;
  for (const out of tx.vout ?? []) {
    if (out.scriptpubkey_address === args.destination) sats += BigInt(out.value ?? 0);
  }

  return sats > 0n
    ? { ok: true, amount: sats, confirmations }
    : { ok: false, reason: 'no output paying that address in this transaction', confirmations };
}

/** Dispatch by chain. */
export async function verifyTransfer(args: {
  chain: string; txHash: string; destination: string;
  contract: string | null; minConfirmations: number;
}): Promise<Verified> {
  if (args.chain === 'bitcoin') {
    return verifyBitcoinTransfer({
      txHash: args.txHash, destination: args.destination,
      minConfirmations: args.minConfirmations,
    });
  }
  if (args.chain === 'ethereum' || args.chain === 'base') {
    // No contract means the chain's native asset (ETH), which moves value on
    // the transaction rather than emitting a token Transfer log.
    if (!args.contract) {
      return verifyEvmNative({
        chain: args.chain, txHash: args.txHash, destination: args.destination,
        minConfirmations: args.minConfirmations,
      });
    }
    return verifyEvmTransfer({
      chain: args.chain, txHash: args.txHash, destination: args.destination,
      contract: args.contract, minConfirmations: args.minConfirmations,
    });
  }
  return { ok: false, reason: `unsupported chain "${args.chain}"` };
}
