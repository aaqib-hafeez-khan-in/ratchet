-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Enable the assets whose chains now have an operator-controlled receiving
-- address. Each address was checksum-validated before being configured:
-- EIP-55 for the EVM chains, bech32 for Bitcoin.
--
-- USDC on Ethereum and Base is stable, so it is priced at parity and needs no
-- oracle. BTC is volatile: it is enabled here but will still refuse to quote
-- unless two independent price sources agree, which is the guard doing its job
-- rather than a misconfiguration.

UPDATE crypto_assets SET enabled = true
 WHERE (chain, token_mint) IN (
   ('ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
   ('base',     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
   ('bitcoin',  'native')
 );

-- Native ETH stays off. It is verifiable only through a different code path
-- (a value transfer emits no ERC-20 Transfer log), and verifyTransfer says so
-- rather than silently accepting something it cannot check.
UPDATE crypto_assets SET enabled = false
 WHERE chain = 'ethereum' AND token_mint = 'native';

-- Bitcoin confirmations: 2 blocks is roughly 20 minutes. Below that a
-- reorganisation can still undo the payment after credit was granted.
UPDATE crypto_assets SET required_confirmations = 2, volatility_bps = 250
 WHERE chain = 'bitcoin' AND token_mint = 'native';
