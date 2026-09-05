// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { freshWorkspace, closePool, getPool } = await import('../helpers.js');
const { beginEnrolment, activate, verifyAndElevate, sessionIsElevated, disable, mfaState, seal, unseal }
  = await import('../../src/domain/mfa.js');
const { createConsoleSession } = await import('../../src/domain/auth.js');
const { totp } = await import('../../src/lib/totp.js');
const { config } = await import('../../src/lib/config.js');
const { sha256 } = await import('../../src/lib/ids.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(false); });
after(async () => { await closePool(); });

/** The session id is the hash of the cookie, as resolveConsoleSession computes it. */
async function session(workspaceId: string) {
  const raw = await createConsoleSession(workspaceId, `${workspaceId}@example.test`);
  return sha256(raw + config.authSecret).toString('hex');
}

describe('the secret is sealed, not stored', () => {
  test('a sealed secret round-trips', () => {
    const s = seal('GEZDGNBVGY3TQOJQ');
    assert.equal(unseal(s).secret, 'GEZDGNBVGY3TQOJQ');
  });

  test('the ciphertext does not contain the secret', () => {
    const s = seal('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const blob = JSON.stringify(s);
    assert.ok(!blob.includes('GEZDGNBVGY3TQOJQ'),
      'the secret is sitting in the record in the clear');
  });

  test('tampering with the ciphertext is detected, not silently decrypted', () => {
    const s = seal('GEZDGNBVGY3TQOJQ');
    const ct = Buffer.from(s.ct, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    assert.throws(() => unseal({ ...s, ct: ct.toString('base64') }),
      /cannot be opened/, 'GCM must reject a modified ciphertext');
  });

  test('a secret sealed under a retired pepper still opens', () => {
    // Rotation: the same lazy acceptance API keys get.
    const retired = 'a-previous-auth-secret-at-least-32-chars-long';
    const sealed = seal('GEZDGNBVGY3TQOJQ', retired);
    const saved = [...config.retiredAuthSecrets];
    (config as { retiredAuthSecrets: string[] }).retiredAuthSecrets = [retired];
    try {
      assert.equal(unseal(sealed).secret, 'GEZDGNBVGY3TQOJQ');
    } finally {
      (config as { retiredAuthSecrets: string[] }).retiredAuthSecrets = saved;
    }
  });
});

describe('enrolment', () => {
  test('nothing is enabled until a code proves the app has the secret', async () => {
    const w = await freshWorkspace(false);
    const { secret, uri } = await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.equal((await mfaState(getPool(), w.workspaceId)).enabled, false,
      'enrolling must not enable it — a failed scan would lock the operator out');

    await activate(getPool(), w.workspaceId, totp(secret));
    assert.equal((await mfaState(getPool(), w.workspaceId)).enabled, true);
  });

  test('activation refuses a wrong code', async () => {
    const w = await freshWorkspace(false);
    await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    await assert.rejects(() => activate(getPool(), w.workspaceId, '000000'),
      (e: { code?: string }) => e.code === 'invalid_request');
    assert.equal((await mfaState(getPool(), w.workspaceId)).enabled, false);
  });

  test('activation issues recovery codes, once', async () => {
    const w = await freshWorkspace(false);
    const { secret } = await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    const { recoveryCodes } = await activate(getPool(), w.workspaceId, totp(secret));
    assert.equal(recoveryCodes.length, 10);
    assert.equal(new Set(recoveryCodes).size, 10, 'codes must not repeat');
    assert.equal((await mfaState(getPool(), w.workspaceId)).recoveryCodesRemaining, 10);
  });
});

describe('verification elevates a session', () => {
  test('a correct code elevates, and only that session', async () => {
    const w = await freshWorkspace(false);
    const { secret } = await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    await activate(getPool(), w.workspaceId, totp(secret));

    const a = await session(w.workspaceId);
    const b = await session(w.workspaceId);
    assert.equal(await sessionIsElevated(getPool(), a), false);

    await verifyAndElevate(getPool(), w.workspaceId, a, totp(secret));
    assert.equal(await sessionIsElevated(getPool(), a), true);
    assert.equal(await sessionIsElevated(getPool(), b), false,
      'elevating one session must not elevate another');
  });

  test('a recovery code works once and is then spent', async () => {
    const w = await freshWorkspace(false);
    const { secret } = await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    const { recoveryCodes } = await activate(getPool(), w.workspaceId, totp(secret));
    const s = await session(w.workspaceId);

    const r = await verifyAndElevate(getPool(), w.workspaceId, s, recoveryCodes[0]!);
    assert.equal(r.usedRecoveryCode, true);
    assert.equal((await mfaState(getPool(), w.workspaceId)).recoveryCodesRemaining, 9);

    await assert.rejects(() => verifyAndElevate(getPool(), w.workspaceId, s, recoveryCodes[0]!),
      'a spent recovery code must not work twice');
  });

  test('repeated wrong codes lock the workspace out', async () => {
    const w = await freshWorkspace(false);
    const { secret } = await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    await activate(getPool(), w.workspaceId, totp(secret));
    const s = await session(w.workspaceId);

    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => verifyAndElevate(getPool(), w.workspaceId, s, '000000'));
    }
    // Six digits is a million guesses against a window that never closes.
    await assert.rejects(
      () => verifyAndElevate(getPool(), w.workspaceId, s, totp(secret)),
      (e: { code?: string }) => e.code === 'rate_limited',
      'a correct code must still be refused while locked out');
    assert.ok((await mfaState(getPool(), w.workspaceId)).lockedUntil);
  });

  test('a successful verification clears the failure count', async () => {
    const w = await freshWorkspace(false);
    const { secret } = await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    await activate(getPool(), w.workspaceId, totp(secret));
    const s = await session(w.workspaceId);
    await assert.rejects(() => verifyAndElevate(getPool(), w.workspaceId, s, '000000'));
    await verifyAndElevate(getPool(), w.workspaceId, s, totp(secret));
    const { rows } = await getPool().query<{ mfa_failed: number }>(
      'SELECT mfa_failed FROM workspaces WHERE id = $1', [w.workspaceId]);
    assert.equal(rows[0]!.mfa_failed, 0);
  });
});

describe('disabling', () => {
  test('requires a current code, and drops every elevation', async () => {
    const w = await freshWorkspace(false);
    const { secret } = await beginEnrolment(getPool(), w.workspaceId, 'ops@example.test');
    await activate(getPool(), w.workspaceId, totp(secret));
    const s = await session(w.workspaceId);

    await assert.rejects(() => disable(getPool(), w.workspaceId, s, '000000'),
      'turning it off without a code would not be a second factor at all');

    await disable(getPool(), w.workspaceId, s, totp(secret));
    const st = await mfaState(getPool(), w.workspaceId);
    assert.equal(st.enabled, false);
    assert.equal(st.recoveryCodesRemaining, 0);
    assert.equal(await sessionIsElevated(getPool(), s), false);
  });
});
