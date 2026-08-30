# Crypto payments — design and honest limits

Ratchet accepts crypto for prepaid credit. The design is shaped by one decision made first and
everything else follows from it: **Ratchet is never a custodian.**

## Non-custodial, structurally

- It holds **no private key**.
- It takes **custody of nothing**. Payments go straight to an address the operator controls.
- Losing the Ratchet database loses **accounting**, never funds.

This is not a convenience choice. Holding customer funds turns a small infrastructure service into
a money transmitter, with the licensing, capital, and compliance obligations that carries. The
watch-only design avoids that entirely rather than hoping nobody notices.

## Three rules the implementation turns on

### 1. Quotes are struck in USD; credit granted is the USD amount

A payer is quoted a token amount computed from a rate at quote time. If the token doubles or halves
before it lands, **the credit is unchanged**. Crediting a token amount instead would let a payer
mint value by timing the market — send when the token is cheap, receive credit priced when it was
expensive.

Tested: an overpayment of 99 USDC against a $10 quote credits **$10**, not $99.

### 2. Which assets are acceptable is operator policy

A payer cannot introduce an asset or set its terms. Assets live in `crypto_assets` with per-asset
minimums, confirmation requirements, quote lifetimes, and volatility haircuts. Only USDC on Solana
is enabled by default.

### 3. Underpayment is never rounded up

A transfer short of the quote is recorded `underpaid` and credits **nothing** until a human
decides. Tested.

## Why USDC first, and what meme coins actually require

The natural next step is other Solana assets, including meme coins. The engineering is
straightforward — `crypto_assets` is already built for it — but three things must be true first,
and none of them is code you can skip:

**A live price oracle.** A volatile asset cannot be quoted without one. This build refuses rather
than inventing a number: `rateUsdPerToken` throws for any non-stable asset when no oracle is
configured. That refusal is deliberate. A guessed price is a free option someone will exercise
against you.

**A volatility haircut that actually covers the window.** `volatility_bps` increases what the payer
sends, absorbing price movement between quote and confirmation. A 60-second quote on an asset that
routinely moves 10% in a minute needs a haircut that reflects that, or the ledger takes the loss.
The haircut is charged to the payer and never reduces credit.

**A treasury policy.** Accepting a volatile asset means holding it, or converting immediately.
Holding is a market position the business did not intend to take. That is a decision for the
operator, and Ratchet deliberately has no opinion and no mechanism — it never touches the funds.

**The honest summary:** accepting meme coins is a *treasury and pricing* problem wearing an
engineering costume. The engineering is a row in a table. Enabling one without an oracle, a
calibrated haircut, and a conversion policy is how a service ends up having sold $10,000 of credit
for $3,000 of tokens.

## What is verified, and what is not

**Verified** (11 tests, `test/integration/crypto.test.ts`): only enabled assets are quotable;
stable assets quote at parity; volatile assets are refused without an oracle; a confirmed payment
credits exactly once and is idempotent on the transaction signature; overpayment credits the quote;
underpayment credits nothing; unknown memos credit nothing; memos are unique; stale quotes expire;
minimums are enforced; crypto is off unless a destination is configured.

**Not verified — no on-chain settlement has been observed.** The chain watcher that would call
`creditConfirmedPayment` is **not implemented**. Crediting is tested by invoking that function
directly with the values a watcher would supply. Everything from the observation onward is real;
the observation itself is not.

To complete it: poll `SOLANA_RPC_URL` for SPL transfers to `SOLANA_DESTINATION_ADDRESS`, match the
memo, and call `creditConfirmedPayment` once confirmations meet the asset's threshold. The
idempotency is already handled — the transaction signature is the dedupe key, so re-reading the
chain cannot double-credit.

## Configuration

| Variable | Meaning |
|---|---|
| `SOLANA_DESTINATION_ADDRESS` | An address **the operator controls**. Ratchet only watches it |
| `SOLANA_RPC_URL` | RPC endpoint for observing transfers |
| `CRYPTO_POLL_INTERVAL_MS` | How often to check, default 20s |

With either of the first two unset, crypto is off and the API says so.

## Regulatory note

This is not legal advice. Accepting crypto has tax, accounting, and in some jurisdictions
licensing implications even when non-custodial. The design minimises exposure by never holding
funds; it does not eliminate the obligation to understand local rules.
