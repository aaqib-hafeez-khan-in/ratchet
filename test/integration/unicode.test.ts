// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * The same visible string has several legal encodings: macOS hands out NFD,
 * nearly everything else NFC. An agent fleet spanning both platforms must not
 * be able to double-execute one action just because two machines spelled the
 * same key with different bytes.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';
import { canonicalFingerprint, normalizeText } from '../../src/lib/ids.js';

const { beginEffect, lookupEffect } = await import('../../src/domain/effects.js');

const NFC = (s: string) => s.normalize('NFC');
const NFD = (s: string) => s.normalize('NFD');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const begin = (key: string, payload: unknown = { k: 1 }) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'email.send', idempotencyKey: key,
  payload, estimatedCostMicros: 0,
});

describe('unicode normalisation', () => {
  test('the two encodings really are different bytes', () => {
    assert.notEqual(NFC('café'), NFD('café'));
    assert.ok(Buffer.byteLength(NFD('café')) > Buffer.byteLength(NFC('café')));
  });

  test('ASCII is left untouched', () => {
    const k = 'invoice:2026-08-30:acct_991';
    assert.equal(normalizeText(k), k);
  });

  test('canonically-equivalent payloads fingerprint identically', () => {
    assert.deepEqual(
      canonicalFingerprint({ customer: NFC('café') }),
      canonicalFingerprint({ customer: NFD('café') }),
    );
  });

  test('equivalent object KEYS fingerprint identically', () => {
    assert.deepEqual(
      canonicalFingerprint({ [NFC('naïve')]: 1 }),
      canonicalFingerprint({ [NFD('naïve')]: 1 }),
    );
  });

  test('genuinely different text is still distinguished', () => {
    assert.notDeepEqual(
      canonicalFingerprint({ a: 'café' }),
      canonicalFingerprint({ a: 'cafe' }),
    );
  });
});

describe('unicode normalisation through the gate', () => {
  test('two platforms writing the same key get ONE effect', async () => {
    const key = `facture:café_${Date.now()}`;
    const a = await begin(NFC(key));
    const b = await begin(NFD(key));
    assert.equal(a.decision, 'execute');
    // The second machine must NOT also be authorised.
    assert.notEqual(b.decision, 'execute', 'NFD spelling double-executed');
    assert.equal(b.effectId, a.effectId);
  });

  test('a retry whose payload is equivalently encoded is not a false key reuse', async () => {
    const key = `retry:${Date.now()}`;
    await begin(key, { name: NFC('café') });
    const again = await begin(key, { name: NFD('café') });
    assert.equal(again.decision, 'in_flight',
      'an honest retry was rejected as idempotency_key_reuse');
  });

  test('a lookup finds an effect written in the other encoding', async () => {
    const key = `lookup:café_${Date.now()}`;
    await begin(NFC(key));
    const found = await lookupEffect(getPool(), ws.workspaceId, 'email.send', NFD(key));
    assert.ok(found, 'lookup missed the effect it should have found');
  });
});
