import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTx, getPool, isUniqueViolation, type Db } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { errors, ApiError } from '../lib/errors.js';
import { addCredit } from './metering.js';
import { config } from '../lib/config.js';
import { usdPrice, PriceUnavailable } from './prices.js';

/**
 * Non-custodial crypto payments.
 *
 * Ratchet holds no private key and takes custody of nothing. The operator
 * configures a receiving address they control; this module watches the chain
 * and credits the ledger once a transfer confirms. Losing this database loses
 * accounting, never funds — which is the only arrangement worth building,
 * because the alternative makes a small service into a custodian with all the
 * obligations that carries.
 *
 * Three rules the design turns on:
 *
 *  1. **Quotes are in USD; credit granted is the USD amount.** The payer sends
 *     a token amount computed from a rate at quote time. If the token doubles
 *     or halves before it lands, the credit is unchanged. Crediting a token
 *     amount instead would let a payer mint value by timing the market.
 *
 *  2. **Which assets are acceptable is operator policy.** A payer cannot
 *     introduce an asset or set its terms. Volatile assets carry a haircut and
 *     a short quote window; stable ones do not need either.
 *
 *  3. **Underpayment is never rounded up.** A transfer short of the quote is
 *     recorded as underpaid and credited for nothing until a human decides.
 */

export type Attribution = 'memo' | 'tx_submission';

export interface CryptoAsset {
  chain: string;
  tokenMint: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
  isStable: boolean;
  quoteTtlSeconds: number;
  volatilityBps: number;
  minUsdMicros: number;
  requiredConfirmations: number;
  attribution: Attribution;
  contractAddress: string | null;
}

export interface PaymentIntent {
  id: string;
  chain: string;
  symbol: string;
  tokenMint: string;
  destination: string;
  usdMicros: number;
  tokenAmount: string;
  tokenDecimals: number;
  displayAmount: string;
  quotedRateUsd: string;
  memo: string;
  state: string;
  expiresAt: string;
  instructions: string[];
}

/**
 * Format a base-unit amount for display, entirely in integer arithmetic.
 *
 * ETH has 18 decimals, and one whole ETH is 1e18 wei — two orders of magnitude
 * past Number.MAX_SAFE_INTEGER. Converting to a float to divide would silently
 * round the amount a payer is told to send, which is not a rounding error in a
 * display, it is a wrong invoice.
 */
export function formatUnits(baseUnits: bigint, decimals: number, maxFractionDigits = 8): string {
  const negative = baseUnits < 0n;
  const v = negative ? -baseUnits : baseUnits;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  let frac = (v % scale).toString().padStart(decimals, '0');
  if (frac.length > maxFractionDigits) frac = frac.slice(0, maxFractionDigits);
  frac = frac.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Convert a USD amount to base units of a token, without floats. */
export function usdToBaseUnits(
  usdMicros: number, ratePerToken: number, decimals: number, haircutBps: number,
): bigint {
  // Work in micro-USD scaled up by the token's decimals, so the only rounding
  // is the final ceil — which rounds in the payer's direction, never ours.
  const withHaircut = BigInt(Math.round(usdMicros * (1 + haircutBps / 10_000)));
  // Rate is carried at 12 decimal places to keep the division exact enough.
  const RATE_SCALE = 1_000_000_000_000n;                 // 1e12
  const USD_SCALE = 1_000_000n;                          // usdMicros is 1e6-scaled
  const rateScaled = BigInt(Math.round(ratePerToken * 1e12));
  if (rateScaled <= 0n) throw new Error('non-positive rate');

  // baseUnits = (usdMicros / USD_SCALE) / rate * 10^decimals
  // Both scales are carried into the numerator so the division is exact and
  // the only rounding is the final ceil.
  const numerator = withHaircut * 10n ** BigInt(decimals) * RATE_SCALE;
  const denominator = rateScaled * USD_SCALE;
  const q = numerator / denominator;
  return numerator % denominator === 0n ? q : q + 1n;   // ceil, in the payer's direction
}

export class CryptoUnavailable extends Error {
  constructor(msg: string) { super(msg); this.name = 'CryptoUnavailable'; }
}

/** Any chain with a receiving address configured makes crypto available. */
export const cryptoEnabled = (): boolean =>
  Object.values(config.crypto.chains).some((c) => c.destination.length > 0);

export const destinationFor = (chain: string): string =>
  config.crypto.chains[chain]?.destination ?? '';

export async function listAssets(db: Db, enabledOnly = true): Promise<CryptoAsset[]> {
  const { rows } = await db.query(
    `SELECT chain, token_mint, symbol, decimals, enabled, is_stable, quote_ttl_seconds,
            volatility_bps, min_usd_micros, required_confirmations,
            attribution, contract_address
       FROM crypto_assets ${enabledOnly ? 'WHERE enabled = true' : ''}
      ORDER BY chain, is_stable DESC, symbol`,
  );
  return rows.map((r) => ({
    chain: r.chain, tokenMint: r.token_mint, symbol: r.symbol, decimals: r.decimals,
    enabled: r.enabled, isStable: r.is_stable, quoteTtlSeconds: r.quote_ttl_seconds,
    volatilityBps: r.volatility_bps, minUsdMicros: Number(r.min_usd_micros),
    requiredConfirmations: r.required_confirmations,
    attribution: r.attribution as Attribution,
    contractAddress: r.contract_address,
  }));
}

/**
 * Price one USD in the given token.
 *
 * A stable asset is priced at parity by definition. Anything else needs a live
 * rate, and this build has no oracle wired — so rather than guess a number and
 * let someone pay with it, quoting a volatile asset fails loudly.
 */
export async function rateUsdPerToken(asset: CryptoAsset): Promise<number> {
  // A stable asset is priced at parity by definition — no oracle, no risk.
  if (asset.isStable) return 1;
  try {
    const { usd } = await usdPrice(asset.symbol);
    return usd;
  } catch (err) {
    if (err instanceof PriceUnavailable) {
      // Surfaced to the caller as "cannot quote right now", which costs one
      // payment. Quoting a price we do not trust costs the difference on every
      // payment until someone notices.
      throw new CryptoUnavailable(`Cannot price ${asset.symbol} right now: ${err.message}`);
    }
    throw err;
  }
}

/** Create a payment intent. Nothing is credited until the chain confirms it. */
export async function createIntent(args: {
  workspaceId: string; tokenMint: string; usdMicros: number; chain?: string;
}): Promise<PaymentIntent> {
  if (!cryptoEnabled()) {
    throw new CryptoUnavailable(
      'Crypto payments are not configured on this instance. The operator must set ' +
      'SOLANA_DESTINATION_ADDRESS (an address they control) and SOLANA_RPC_URL.');
  }

  const assets = await listAssets(getPool(), true);
  const asset = assets.find((a) =>
    a.tokenMint === args.tokenMint && (!args.chain || a.chain === args.chain));
  if (!asset) {
    throw errors.invalid('That asset is not accepted by this instance.',
      { accepted: assets.map((a) => ({ symbol: a.symbol, mint: a.tokenMint })) });
  }
  if (args.usdMicros < asset.minUsdMicros) {
    throw errors.invalid(
      `Minimum payment for ${asset.symbol} is $${(asset.minUsdMicros / 1e6).toFixed(2)}.`,
      { minUsdMicros: asset.minUsdMicros });
  }

  const destination = destinationFor(asset.chain);
  if (!destination) {
    throw new CryptoUnavailable(
      `No receiving address is configured for ${asset.chain}, so a payment there would go ` +
      'nowhere. The operator must set it before that chain can be quoted.');
  }

  const rate = await rateUsdPerToken(asset);
  // The haircut protects the ledger from a price move between quote and
  // confirmation. It increases what the payer sends; it never reduces credit.
  // Computed in integer arithmetic — see usdToBaseUnits.
  const tokenAmount = usdToBaseUnits(args.usdMicros, rate, asset.decimals, asset.volatilityBps);

  const memo = `ratchet-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const id = newId('cpi');
  const expiresAt = new Date(Date.now() + asset.quoteTtlSeconds * 1000);

  await getPool().query(
    `INSERT INTO crypto_intents
       (id, workspace_id, chain, token_mint, token_symbol, destination, usd_micros,
        token_amount, token_decimals, quoted_rate_usd, memo, expires_at, attribution)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, args.workspaceId, asset.chain, asset.tokenMint, asset.symbol,
     destination, args.usdMicros, tokenAmount.toString(),
     asset.decimals, rate, memo, expiresAt, asset.attribution],
  );

  const display = formatUnits(tokenAmount, asset.decimals, Math.min(asset.decimals, 8));

  return {
    id, chain: asset.chain, symbol: asset.symbol, tokenMint: asset.tokenMint,
    destination,
    usdMicros: args.usdMicros,
    tokenAmount: tokenAmount.toString(),
    tokenDecimals: asset.decimals,
    displayAmount: display,
    quotedRateUsd: String(rate),
    memo,
    state: 'awaiting_payment',
    expiresAt: expiresAt.toISOString(),
    instructions: asset.attribution === 'memo'
      ? [
          `Send exactly ${display} ${asset.symbol} on ${asset.chain} to ${destination}`,
          `Include the memo "${memo}" — it is how the payment is attributed to your workspace.`,
          `This quote expires at ${expiresAt.toISOString()}. After that, request a new one.`,
          `Credit of $${(args.usdMicros / 1e6).toFixed(2)} is applied automatically after ` +
            `${asset.requiredConfirmations} confirmation(s). A transfer short of the quoted ` +
            'amount is not credited.',
        ]
      : [
          `Send exactly ${display} ${asset.symbol} on ${asset.chain} to ${destination}`,
          `${asset.chain} has no memo field, so afterwards submit your transaction hash to ` +
            `POST /v1/billing/crypto/intents/${id}/submit — that is how the payment is ` +
            'attributed to your workspace.',
          `This quote expires at ${expiresAt.toISOString()}. After that, request a new one.`,
          `Credit of $${(args.usdMicros / 1e6).toFixed(2)} is applied once the transaction is ` +
            `verified on-chain with ${asset.requiredConfirmations} confirmation(s).`,
        ],
  };
}

/**
 * Credit a confirmed on-chain payment. Idempotent on the transaction
 * signature, which is what makes a replayed chain observation safe.
 */
export async function creditConfirmedPayment(args: {
  memo: string; txSignature: string; observedAmount: bigint; confirmations: number;
}): Promise<{ credited: boolean; reason?: string; workspaceId?: string }> {
  return withTx(async (tx: PoolClient) => {
    const { rows } = await tx.query(
      `SELECT id, workspace_id, token_amount, usd_micros, token_symbol, state, expires_at
         FROM crypto_intents WHERE memo = $1 FOR UPDATE`,
      [args.memo],
    );
    const intent = rows[0];
    if (!intent) return { credited: false, reason: 'no intent for that memo' };
    if (intent.state === 'credited') return { credited: false, reason: 'already credited' };

    // A short payment is never rounded up. Recording it as underpaid leaves a
    // human to decide, which is the only honest option.
    if (args.observedAmount < BigInt(intent.token_amount)) {
      await tx.query(
        `UPDATE crypto_intents SET state='underpaid', observed_amount=$2, tx_signature=$3,
                confirmations=$4 WHERE id=$1`,
        [intent.id, args.observedAmount.toString(), args.txSignature, args.confirmations]);
      return { credited: false, reason: 'underpaid', workspaceId: intent.workspace_id };
    }

    await tx.query(
      `UPDATE crypto_intents SET state='credited', observed_amount=$2, tx_signature=$3,
              confirmations=$4, credited_at=now() WHERE id=$1`,
      [intent.id, args.observedAmount.toString(), args.txSignature, args.confirmations]);

    // The transaction signature is globally unique on-chain, so it is the right
    // idempotency key: the same payment cannot credit twice however many times
    // the chain is re-read.
    await addCredit(tx, intent.workspace_id, Number(intent.usd_micros),
      `crypto:${args.txSignature}`,
      { chain: 'solana', symbol: intent.token_symbol, tx: args.txSignature, memo: args.memo });

    await tx.query(
      `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
       VALUES ($1,'billing.crypto_credited','system',$2,$3)`,
      [intent.workspace_id, intent.id,
       JSON.stringify({ tx: args.txSignature, usdMicros: Number(intent.usd_micros) })]);

    return { credited: true, workspaceId: intent.workspace_id };
  });
}

/**
 * Settle a payment on a chain with no memo, from a hash the payer submits.
 *
 * The submission is untrusted input: it is a claim, not evidence. Everything
 * that matters is re-derived from the chain — destination, asset, amount, and
 * confirmations — and the unique index on (chain, tx) is what stops one
 * transaction being submitted against several quotes.
 */
export async function submitTransaction(args: {
  workspaceId: string; intentId: string; txHash: string;
  verify: (a: { chain: string; txHash: string; destination: string;
                contract: string | null; minConfirmations: number })
          => Promise<{ ok: boolean; reason?: string; amount?: bigint; confirmations?: number }>;
}): Promise<{ credited: boolean; state: string; reason?: string }> {
  const tx = args.txHash.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(tx)) {
    throw errors.invalid('That does not look like a transaction hash.');
  }

  const { rows } = await getPool().query(
    `SELECT i.id, i.chain, i.token_mint, i.destination, i.state, i.memo, i.expires_at,
            a.required_confirmations, a.contract_address
       FROM crypto_intents i
       JOIN crypto_assets a ON a.chain = i.chain AND a.token_mint = i.token_mint
      WHERE i.id = $1 AND i.workspace_id = $2`,
    [args.intentId, args.workspaceId]);
  const intent = rows[0];
  if (!intent) throw errors.notFound('No such payment intent in this workspace.');
  if (intent.state === 'credited') return { credited: false, state: 'credited', reason: 'already credited' };

  // Claim the hash first. The unique index means a transaction submitted
  // against a second quote fails here rather than being verified twice.
  try {
    await getPool().query(
      `UPDATE crypto_intents SET submitted_tx=$2, submitted_at=now(), state='submitted'
        WHERE id=$1`, [intent.id, tx]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw errors.conflict('transaction_already_used',
        'That transaction has already been submitted for another payment.');
    }
    throw err;
  }

  const v = await args.verify({
    chain: intent.chain, txHash: tx, destination: intent.destination,
    contract: intent.contract_address, minConfirmations: intent.required_confirmations,
  });

  if (!v.ok) {
    await getPool().query(
      `UPDATE crypto_intents SET state='confirming', verify_error=$2, confirmations=$3
        WHERE id=$1`, [intent.id, v.reason ?? 'not verified', v.confirmations ?? 0]);
    return { credited: false, state: 'confirming', reason: v.reason };
  }

  const r = await creditConfirmedPayment({
    memo: intent.memo, txSignature: tx,
    observedAmount: v.amount!, confirmations: v.confirmations ?? 0,
  });
  return r.credited
    ? { credited: true, state: 'credited' }
    : { credited: false, state: r.reason === 'underpaid' ? 'underpaid' : 'confirming', reason: r.reason };
}

export async function expireStaleIntents(): Promise<number> {
  const res = await getPool().query(
    `UPDATE crypto_intents SET state='expired'
      WHERE state='awaiting_payment' AND expires_at <= now()`);
  return res.rowCount ?? 0;
}

export async function listIntents(db: Db, workspaceId: string, limit = 25) {
  const { rows } = await db.query(
    `SELECT id, chain, token_symbol, usd_micros, token_amount, token_decimals,
            memo, state, tx_signature, created_at, expires_at, credited_at
       FROM crypto_intents WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, Math.min(limit, 100)]);
  return rows.map((r) => ({
    id: r.id, chain: r.chain, symbol: r.token_symbol,
    usdMicros: Number(r.usd_micros),
    amount: formatUnits(BigInt(r.token_amount), r.token_decimals, 8),
    memo: r.memo, state: r.state, txSignature: r.tx_signature,
    createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(),
    creditedAt: r.credited_at ? r.credited_at.toISOString() : null,
  }));
}

export { ApiError };
