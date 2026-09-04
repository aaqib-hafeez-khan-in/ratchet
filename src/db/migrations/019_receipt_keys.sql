-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
-- Key rotation for receipts.
--
-- The signing key is derived from AUTH_SECRET. Rotating that secret — which an
-- operator should be able to do, and must be able to do after a suspected
-- compromise — silently invalidated every receipt ever issued: they would still
-- be signed correctly, but the only key we published could no longer verify
-- them. A customer auditing last quarter would see the whole log fail.
--
-- That made AUTH_SECRET effectively unrotatable, which is a bad property for a
-- secret, and it made long-term verifiability a promise we could not keep.
--
-- The fix rests on a simple asymmetry: a PUBLIC key is not a secret. We record
-- the public half of every signing key we have ever used, tagged with a key id,
-- and each receipt records which key signed it. Rotating AUTH_SECRET then
-- changes only what we sign NEW receipts with; every old receipt still verifies
-- against its own key, which we keep publishing.
--
-- We lose the ability to sign with a retired key, which is exactly what
-- rotation is supposed to achieve.
CREATE TABLE receipt_keys (
  kid           TEXT PRIMARY KEY,
  public_key    TEXT NOT NULL,
  algorithm     TEXT NOT NULL DEFAULT 'ed25519',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which key signed each receipt. NULL means it predates rotation support and is
-- verified against the oldest recorded key.
ALTER TABLE receipts ADD COLUMN kid TEXT;

-- Checkpoints are signed too, so they need the same treatment or a rotation
-- would break the very attestation that lets a pruned chain still verify.
ALTER TABLE receipt_checkpoints ADD COLUMN kid TEXT;
