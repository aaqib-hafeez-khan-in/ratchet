-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Base is no longer accepted. The operator takes Solana, Ethereum and Bitcoin.
--
-- Disabled rather than deleted. The chain column's CHECK still admits 'base',
-- and the rows stay, because a payment recorded against a chain we later stopped
-- accepting is still a payment that happened — deleting the asset would orphan
-- its history and rewrite what the ledger says was true at the time.
--
-- Two independent switches have to agree for a chain to be live: an enabled
-- asset here, and a destination address in the environment. This closes the
-- first. BASE_DESTINATION_ADDRESS is unset separately, so neither one alone can
-- bring the chain back by accident.
--
-- Safe to run: there were no crypto intents on any chain when this was written,
-- so nothing was in flight to strand.

UPDATE crypto_assets SET enabled = false WHERE chain = 'base';
