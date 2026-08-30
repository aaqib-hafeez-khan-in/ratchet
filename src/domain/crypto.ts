import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTx, getPool, type Db } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { errors, ApiError } from '../lib/errors.js';
import { addCredit } from './metering.js';
import { config } from '../lib/config.js';

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

export class CryptoUnavailable extends Error {
  constructor(msg: string) { super(msg); this.name = 'CryptoUnavailable'; }
}

export const cryptoEnabled = (): boolean =>
  config.crypto.solanaDestination.length > 0 && config.crypto.rpcUrl.length > 0;

export async function listAssets(db: Db, enabledOnly = true): Promise<CryptoAsset[]> {
  const { rows } = await db.query(
    `SELECT chain, token_mint, symbol, decimals, enabled, is_stable, quote_ttl_seconds,
            volatility_bps, min_usd_micros, required_confirmations
       FROM crypto_assets ${enabledOnly ? 'WHERE enabled = true' : ''}
      ORDER BY is_stable DESC, symbol`,
  );
  return rows.map((r) => ({
    chain: r.chain, tokenMint: r.token_mint, symbol: r.symbol, decimals: r.decimals,
    enabled: r.enabled, isStable: r.is_stable, quoteTtlSeconds: r.quote_ttl_seconds,
    volatilityBps: r.volatility_bps, minUsdMicros: Number(r.min_usd_micros),
    requiredConfirmations: r.required_confirmations,
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
  if (asset.isStable) return 1;
  throw new CryptoUnavailable(
    `${asset.symbol} is not a stable asset and no price oracle is configured on this instance. ` +
    'Quoting a volatile asset without a live rate would mean inventing a price, so it is refused. ' +
    'See docs/handoff/CRYPTO_PAYMENTS.md.');
}

/** Create a payment intent. Nothing is credited until the chain confirms it. */
export async function createIntent(args: {
  workspaceId: string; tokenMint: string; usdMicros: number;
}): Promise<PaymentIntent> {
  if (!cryptoEnabled()) {
    throw new CryptoUnavailable(
      'Crypto payments are not configured on this instance. The operator must set ' +
      'SOLANA_DESTINATION_ADDRESS (an address they control) and SOLANA_RPC_URL.');
  }

  const assets = await listAssets(getPool(), true);
  const asset = assets.find((a) => a.tokenMint === args.tokenMint);
  if (!asset) {
    throw errors.invalid('That asset is not accepted by this instance.',
      { accepted: assets.map((a) => ({ symbol: a.symbol, mint: a.tokenMint })) });
  }
  if (args.usdMicros < asset.minUsdMicros) {
    throw errors.invalid(
      `Minimum payment for ${asset.symbol} is $${(asset.minUsdMicros / 1e6).toFixed(2)}.`,
      { minUsdMicros: asset.minUsdMicros });
  }

  const rate = await rateUsdPerToken(asset);
  // The haircut protects the ledger from a price move between quote and
  // confirmation. It increases what the payer sends; it never reduces credit.
  const withHaircut = args.usdMicros * (1 + asset.volatilityBps / 10_000);
  const whole = withHaircut / 1e6 / rate;
  const tokenAmount = BigInt(Math.ceil(whole * 10 ** asset.decimals));

  const memo = `ratchet-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const id = newId('cpi');
  const expiresAt = new Date(Date.now() + asset.quoteTtlSeconds * 1000);

  await getPool().query(
    `INSERT INTO crypto_intents
       (id, workspace_id, chain, token_mint, token_symbol, destination, usd_micros,
        token_amount, token_decimals, quoted_rate_usd, memo, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, args.workspaceId, asset.chain, asset.tokenMint, asset.symbol,
     config.crypto.solanaDestination, args.usdMicros, tokenAmount.toString(),
     asset.decimals, rate, memo, expiresAt],
  );

  const display = (Number(tokenAmount) / 10 ** asset.decimals).toFixed(Math.min(asset.decimals, 6));

  return {
    id, chain: asset.chain, symbol: asset.symbol, tokenMint: asset.tokenMint,
    destination: config.crypto.solanaDestination,
    usdMicros: args.usdMicros,
    tokenAmount: tokenAmount.toString(),
    tokenDecimals: asset.decimals,
    displayAmount: display,
    quotedRateUsd: String(rate),
    memo,
    state: 'awaiting_payment',
    expiresAt: expiresAt.toISOString(),
    instructions: [
      `Send exactly ${display} ${asset.symbol} to ${config.crypto.solanaDestination}`,
      `Include the memo "${memo}" — it is how the payment is attributed to your workspace.`,
      `This quote expires at ${expiresAt.toISOString()}. After that, request a new one.`,
      `Credit of $${(args.usdMicros / 1e6).toFixed(2)} is applied after ` +
        `${asset.requiredConfirmations} confirmation(s). A transfer short of the quoted amount ` +
        'is not credited automatically.',
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
    amount: (Number(r.token_amount) / 10 ** r.token_decimals).toFixed(6),
    memo: r.memo, state: r.state, txSignature: r.tx_signature,
    createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(),
    creditedAt: r.credited_at ? r.credited_at.toISOString() : null,
  }));
}

export { ApiError };
