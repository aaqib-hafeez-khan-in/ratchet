-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Non-custodial crypto payments.
--
-- Ratchet never holds a private key and never takes custody of funds. The
-- operator configures a receiving address they control; Ratchet only WATCHES
-- the chain and credits the ledger when a payment confirms. Losing the Ratchet
-- database would therefore lose accounting, never money.
--
-- Every credit still flows through the same idempotent ledger as card
-- payments, so there is one accounting path, not two.

CREATE TABLE crypto_intents (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chain           TEXT NOT NULL CHECK (chain IN ('solana')),
  -- SPL mint address. Which assets are acceptable is operator policy, not
  -- something a payer chooses.
  token_mint      TEXT NOT NULL,
  token_symbol    TEXT NOT NULL,
  -- The operator's own receiving address. Ratchet does not control it.
  destination     TEXT NOT NULL,
  -- Quoted in USD first, then converted. Credit granted is always the USD
  -- amount, never a token amount, so a price move between quote and settlement
  -- cannot mint credit that was not paid for.
  usd_micros      BIGINT NOT NULL CHECK (usd_micros > 0),
  token_amount    NUMERIC(38,0) NOT NULL,
  token_decimals  INTEGER NOT NULL,
  -- The rate this quote was struck at, and when it expires. A volatile asset
  -- needs a short window or the quote becomes a free option against us.
  quoted_rate_usd NUMERIC(38,12) NOT NULL,
  -- Included in the transfer so a payment can be attributed to a workspace.
  memo            TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL DEFAULT 'awaiting_payment'
                    CHECK (state IN ('awaiting_payment','confirming','credited','expired','underpaid')),
  tx_signature    TEXT UNIQUE,
  confirmations   INTEGER NOT NULL DEFAULT 0,
  observed_amount NUMERIC(38,0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  credited_at     TIMESTAMPTZ
);
CREATE INDEX crypto_intents_ws_idx ON crypto_intents (workspace_id, created_at DESC);
CREATE INDEX crypto_intents_watch_idx ON crypto_intents (state, expires_at)
  WHERE state IN ('awaiting_payment','confirming');

-- Which assets this instance accepts, and on what terms. Operator-controlled:
-- a payer cannot introduce an asset, and cannot set its terms.
CREATE TABLE crypto_assets (
  chain             TEXT NOT NULL,
  token_mint        TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  decimals          INTEGER NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  -- Stable assets can be priced at parity. Volatile ones need a live rate and
  -- a much shorter quote window.
  is_stable         BOOLEAN NOT NULL DEFAULT false,
  quote_ttl_seconds INTEGER NOT NULL DEFAULT 900
                      CHECK (quote_ttl_seconds BETWEEN 30 AND 3600),
  -- Haircut applied to volatile assets, in basis points, to absorb price move
  -- between quote and confirmation. Charged to the payer, never to the ledger.
  volatility_bps    INTEGER NOT NULL DEFAULT 0 CHECK (volatility_bps BETWEEN 0 AND 5000),
  min_usd_micros    BIGINT NOT NULL DEFAULT 5000000,
  required_confirmations INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, token_mint)
);

-- USDC on Solana, enabled by default: stable, so no oracle risk and no haircut.
INSERT INTO crypto_assets
  (chain, token_mint, symbol, decimals, enabled, is_stable, quote_ttl_seconds,
   volatility_bps, min_usd_micros, required_confirmations)
VALUES
  ('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 6,
   true, true, 900, 0, 5000000, 1)
ON CONFLICT DO NOTHING;
