/**
 * x402 — machine payments over HTTP.
 *
 * An agent that exhausts its anonymous quota hits a wall it cannot get past on
 * its own: someone has to go and sign up. x402 removes that. The agent gets a
 * 402 describing what to pay, retries with a signed authorization, and
 * continues. No account, no card, no human.
 *
 * Wire format follows the x402 v2 spec: a base64 `PaymentRequired` object in
 * the PAYMENT-REQUIRED response header, a base64 `PaymentPayload` in the
 * client's PAYMENT-SIGNATURE header, and a `SettlementResponse` back in
 * PAYMENT-RESPONSE.
 *
 * WE DO NOT VERIFY OR SETTLE LOCALLY, and the reason is worth stating rather
 * than discovering later. Settling an EIP-3009 authorization means submitting a
 * transaction, which means a hot wallet holding gas — an operational and
 * custody burden this service deliberately does not take on. Since a facilitator
 * is required for the money to move at all, verifying the signature ourselves
 * would duplicate work we still could not finish, and would mean hand-rolling
 * secp256k1 recovery into a codebase with nine dependencies. The spec sanctions
 * facilitator verification explicitly.
 *
 * The consequence is a hard gate: without a configured facilitator, x402 is
 * OFF. We never advertise a price we cannot collect.
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY. Access is granted only
 * after SETTLE succeeds, never after VERIFY. Verify says the signature is
 * well-formed; settle says the money moved. Granting on verify would hand out
 * paid capacity for an authorization that never lands.
 */
import { getPool } from '../db/pool.js';
import { config } from '../lib/config.js';
import { newId } from '../lib/ids.js';

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  accepted?: PaymentRequirements;
  payload?: {
    signature?: string;
    authorization?: {
      from?: string; to?: string; value?: string;
      validAfter?: string; validBefore?: string; nonce?: string;
    };
  };
}

export function x402Enabled(): boolean {
  const c = config.x402;
  return Boolean(c.facilitatorUrl && c.payTo && c.asset && c.network);
}

/** What one payment buys, in micro-USD of credit. */
export function creditForPayment(): number {
  return config.x402.creditMicros;
}

/**
 * The 402 body and header value.
 *
 * `amount` is in the asset's own base units — 6 decimals for USDC, so
 * "1000000" is one dollar. Expressing it in the token's units rather than a
 * fiat string keeps the server out of the business of quoting exchange rates.
 */
export function paymentRequired(resourceUrl: string): PaymentRequired {
  const c = config.x402;
  return {
    x402Version: 2,
    error: 'Anonymous quota exhausted. Pay to continue, or claim this workspace with an email.',
    resource: {
      url: resourceUrl,
      description: `${c.creditMicros / 1e6} USD of Ratchet credit`,
      mimeType: 'application/json',
    },
    accepts: [{
      scheme: 'exact',
      network: c.network,
      amount: c.amount,
      asset: c.asset,
      payTo: c.payTo,
      maxTimeoutSeconds: 120,
      /**
       * `name` and `version` are the token contract's EIP-712 domain fields,
       * and they are not decoration: the client signs over that domain, so
       * without them the signature cannot be reconstructed. A live facilitator
       * rejects the payment with `invalid_exact_evm_missing_eip712_domain`,
       * which is how this omission was found. They are token-specific, so they
       * are configurable alongside the asset.
       */
      extra: {
        assetTransferMethod: 'eip3009',
        name: c.assetName,
        version: c.assetVersion,
      },
    }],
  };
}

export const encodeHeader = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString('base64');

export function decodePayload(header: string): PaymentPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as PaymentPayload : null;
  } catch {
    return null;
  }
}

export class PaymentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

async function facilitator(path: string, body: unknown): Promise<Record<string, unknown>> {
  const url = `${config.x402.facilitatorUrl!.replace(/\/+$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.x402.facilitatorKey ? { authorization: `Bearer ${config.x402.facilitatorKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }
  if (!res.ok) {
    throw new PaymentError('facilitator_error',
      `Facilitator ${path} returned ${res.status}.`);
  }
  return json;
}

/**
 * Verify, settle, and credit — in that order, and only crediting on settlement.
 *
 * The authorization nonce is claimed in the database BEFORE the facilitator is
 * asked to settle. A unique index makes a concurrent or replayed attempt fail
 * outright rather than producing a second settlement; this is the same
 * at-most-once discipline the product sells, applied to its own billing.
 */
export async function settlePayment(input: {
  workspaceId: string;
  payload: PaymentPayload;
  resourceUrl: string;
}): Promise<{ creditMicros: number; settlementRef: string | null }> {
  if (!x402Enabled()) {
    throw new PaymentError('x402_disabled', 'This deployment does not accept x402 payments.');
  }

  const auth = input.payload.payload?.authorization;
  const nonce = auth?.nonce;
  if (!nonce || !input.payload.payload?.signature) {
    throw new PaymentError('invalid_payment',
      'PAYMENT-SIGNATURE is missing the authorization nonce or signature.');
  }

  const required = paymentRequired(input.resourceUrl).accepts[0]!;

  // Refuse an underpayment before spending a facilitator call on it. The
  // client chooses the amount it signs, so this cannot be taken on trust.
  if (auth.value !== required.amount) {
    throw new PaymentError('insufficient_payment',
      `Authorization is for ${auth.value}; ${required.amount} is required.`);
  }
  if (auth.to && auth.to.toLowerCase() !== required.payTo.toLowerCase()) {
    throw new PaymentError('wrong_recipient', 'Authorization pays a different address.');
  }

  const pool = getPool();
  const id = newId('x4');

  // Claim the nonce first. The unique index is what enforces at-most-once here;
  // checking for an existing row and then inserting would race.
  try {
    await pool.query(
      `INSERT INTO x402_payments
         (id, workspace_id, nonce, network, asset, amount, payer, credit_micros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, input.workspaceId, nonce, required.network, required.asset,
       required.amount, auth.from ?? null, config.x402.creditMicros],
    );
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      throw new PaymentError('payment_replayed',
        'This payment authorization has already been used.');
    }
    throw err;
  }

  const body = {
    x402Version: 2,
    paymentPayload: input.payload,
    paymentRequirements: required,
  };

  try {
    const verified = await facilitator('/verify', body);
    if (verified.isValid === false) {
      throw new PaymentError('payment_invalid',
        String(verified.invalidReason ?? 'The facilitator rejected this authorization.'));
    }

    // Only now is anything granted. A valid signature is not a payment.
    const settled = await facilitator('/settle', body);
    if (settled.success === false) {
      throw new PaymentError('settlement_failed',
        String(settled.errorReason ?? 'Settlement failed.'));
    }
    const ref = typeof settled.transaction === 'string' ? settled.transaction : null;

    await pool.query(
      `UPDATE x402_payments SET state='settled', settlement_ref=$2, settled_at=now()
        WHERE id=$1`, [id, ref]);
    await pool.query(
      `UPDATE workspaces SET credit_micros = credit_micros + $2 WHERE id = $1`,
      [input.workspaceId, config.x402.creditMicros]);

    return { creditMicros: config.x402.creditMicros, settlementRef: ref };
  } catch (err) {
    // Mark it failed rather than deleting: the nonce stays claimed, so a
    // failed authorization cannot be retried into a second settlement attempt
    // while the first is still in flight somewhere.
    await pool.query(`UPDATE x402_payments SET state='failed' WHERE id=$1`, [id])
      .catch(() => {});
    throw err;
  }
}
