-- Enable native ETH now that value transfers are verifiable.
--
-- Verification reads tx.to and tx.value directly, so only DIRECT wallet
-- transfers settle. ETH forwarded by a contract arrives as an internal
-- transfer, invisible in the transaction and receipt, and the verifier says so
-- rather than appearing to check something it cannot.
--
-- Volatile, so it quotes only when two independent price sources agree. The
-- 200bps haircut and a 5-minute quote window cover movement between quote and
-- confirmation.
UPDATE crypto_assets
   SET enabled = true, volatility_bps = 200, quote_ttl_seconds = 300,
       required_confirmations = 12, min_usd_micros = 25000000
 WHERE chain = 'ethereum' AND token_mint = 'native';

-- Native ETH on Base as well: same asset, far cheaper to send.
INSERT INTO crypto_assets
  (chain, token_mint, symbol, decimals, enabled, is_stable, quote_ttl_seconds,
   volatility_bps, min_usd_micros, required_confirmations, attribution, contract_address)
VALUES
  ('base', 'native', 'ETH', 18, true, false, 300, 200, 10000000, 12, 'tx_submission', NULL)
ON CONFLICT (chain, token_mint) DO UPDATE
  SET enabled = true, volatility_bps = 200, quote_ttl_seconds = 300;
