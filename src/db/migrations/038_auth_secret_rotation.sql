-- Which secret an API key's hash was made with.
--
-- api_keys.secret_hash is HMAC(AUTH_SECRET, secret) and carried no record of
-- WHICH AUTH_SECRET. Rotating therefore invalidated every key in existence at
-- the same instant, with no way to tell an old key from a forged one — so the
-- one action an operator must take after a suspected compromise was the one
-- action nobody could take. RECOVERY.md called it "Last resort", which was an
-- accurate description of a control that did not exist.
--
-- The fix is the one the receipt log already uses: record which key signed each
-- record, and resolve per record rather than assuming whatever is current. A
-- receipt carries a `kid` inside its signed body; a row here carries the kid of
-- the pepper its hash was made with.
--
-- NULL means "made before this column existed", which can only be the secret
-- that was current at the time — rotation was impossible until now. Those rows
-- are verified against every configured secret and stamped on first use, so no
-- boot-time backfill has to guess.
--
-- The kid is a truncated hash of the secret. That is safe to store beside the
-- hashes it describes: it is derived from a high-entropy secret under its own
-- domain separator, and anyone who could invert it already holds the pepper.
ALTER TABLE api_keys
  ADD COLUMN secret_kid TEXT;

COMMENT ON COLUMN api_keys.secret_kid IS
  'Fingerprint of the AUTH_SECRET this row''s secret_hash was derived under. NULL means pre-rotation; verified against all configured secrets and stamped on first use.';

-- The question an operator must answer before dropping a retired secret: is
-- anything still using it? Partial, because the rows that matter are the live
-- ones — a revoked key never authenticates again and cannot hold a rotation open.
CREATE INDEX api_keys_secret_kid_idx ON api_keys (secret_kid)
  WHERE revoked_at IS NULL;
