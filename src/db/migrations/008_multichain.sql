-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Multi-chain crypto payments: Solana, Ethereum, Base, Bitcoin.
--
-- Attribution differs by chain and that difference is structural, not cosmetic.
-- Solana transfers can carry a memo, so a payment identifies itself and the
-- watcher can credit it unattended. Ethereum, Base, and Bitcoin have no
-- practical memo, so the payer submits the transaction hash afterwards and
-- Ratchet verifies it on-chain.
--
-- The rejected alternative was deriving a unique deposit address per workspace.
-- It is non-custodial in principle, but it puts Ratchet in the business of
-- tracking addresses the operator must sweep, and a mistake there strands
-- funds. Verifying a hash the payer hands us needs no key material at all.

ALTER TABLE crypto_assets DROP CONSTRAINT IF EXISTS crypto_assets_chain_check;
ALTER TABLE crypto_intents DROP CONSTRAINT IF EXISTS crypto_intents_chain_check;
ALTER TABLE crypto_intents ADD CONSTRAINT crypto_intents_chain_check
  CHECK (chain IN ('solana','ethereum','base','bitcoin'));

ALTER TABLE crypto_assets
  -- 'memo'          the transfer carries the memo; the watcher finds it
  -- 'tx_submission' the payer submits the transaction hash; we verify it
  ADD COLUMN attribution TEXT NOT NULL DEFAULT 'memo'
    CHECK (attribution IN ('memo','tx_submission')),
  -- ERC-20 contract, or NULL for a chain's native asset (ETH, BTC).
  ADD COLUMN contract_address TEXT;

ALTER TABLE crypto_intents
  ADD COLUMN attribution TEXT NOT NULL DEFAULT 'memo',
  -- Set when the payer submits a hash for a non-memo chain.
  ADD COLUMN submitted_tx TEXT,
  ADD COLUMN submitted_at TIMESTAMPTZ,
  ADD COLUMN verify_error TEXT;

-- A transaction may only ever settle one intent. Without this, one payment
-- could be submitted against several quotes and credited more than once.
CREATE UNIQUE INDEX crypto_intents_submitted_tx_idx
  ON crypto_intents (chain, lower(submitted_tx)) WHERE submitted_tx IS NOT NULL;

ALTER TABLE crypto_intents DROP CONSTRAINT IF EXISTS crypto_intents_state_check;
ALTER TABLE crypto_intents ADD CONSTRAINT crypto_intents_state_check
  CHECK (state IN ('awaiting_payment','submitted','confirming','credited','expired','underpaid','rejected'));

-- Stablecoins across the EVM chains. Disabled until the operator sets a
-- receiving address for that chain — an enabled asset with nowhere to send it
-- would quote a payment into the void.
INSERT INTO crypto_assets
  (chain, token_mint, symbol, decimals, enabled, is_stable, quote_ttl_seconds,
   volatility_bps, min_usd_micros, required_confirmations, attribution, contract_address)
VALUES
  ('ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6,
   false, true, 1800, 0, 25000000, 12, 'tx_submission', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  ('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 6,
   false, true, 1800, 0, 10000000, 12, 'tx_submission', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  -- Native assets. Volatile, so they stay off until a price oracle is
  -- configured; quoting them without a live rate would mean inventing a price.
  ('ethereum', 'native', 'ETH', 18,
   false, false, 300, 200, 25000000, 12, 'tx_submission', NULL),
  ('bitcoin', 'native', 'BTC', 8,
   false, false, 300, 250, 25000000, 2, 'tx_submission', NULL)
ON CONFLICT DO NOTHING;
