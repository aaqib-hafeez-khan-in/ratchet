/**
 * The free plan belongs to an address that answered.
 *
 * Claiming used to be enough, and claiming only wrote an email nobody checked.
 * Measured before this: one source could open five workspaces an hour, each a
 * full free plan, with addresses that never had to exist — and rotating the
 * source removed even that bound.
 *
 * The control gates the allowance, never the signup. Everything here is about
 * that distinction, and about the migration not demoting anyone who was already
 * a customer.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { freshWorkspace, closePool, getPool, setPeriodDecisions } from '../helpers.js';

const { issueVerification, redeemVerification, isVerified, TOKEN_TTL_HOURS } =
  await import('../../src/domain/verification.js');
const { meterEffect } = await import('../../src/domain/metering.js');
const { ANONYMOUS_EFFECT_QUOTA } = await import('../../src/domain/auth.js');

after(async () => { await closePool(); });

const unverify = (id: string) =>
  getPool().query('UPDATE workspaces SET email_verified_at = NULL WHERE id = $1', [id]);

describe('confirming an address', () => {
  test('a fresh link works once and is idempotent on a second click', async () => {
    const ws = await freshWorkspace();
    await unverify(ws.workspaceId);

    const token = await issueVerification(ws.workspaceId);
    const first = await redeemVerification(token);
    assert.equal(first.ok, true);
    assert.equal(first.ok && first.alreadyVerified, false);
    assert.equal(await isVerified(ws.workspaceId), true);

    // Mail clients prefetch links and people click twice. The second click must
    // land on "already confirmed" — not on an error, which is what somebody
    // whose account is perfectly fine would otherwise be shown.
    const second = await redeemVerification(token);
    assert.equal(second.ok, true, 'a second click is not a failure');
    assert.equal(second.ok && second.alreadyVerified, true);
    assert.equal(await isVerified(ws.workspaceId), true, 'and it stays verified');
  });

  test('a token that never existed is refused without saying why', async () => {
    const r = await redeemVerification('a'.repeat(43));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'unknown');
  });

  test('an expired link is refused, and says so distinctly', async () => {
    const ws = await freshWorkspace();
    await unverify(ws.workspaceId);
    const token = await issueVerification(ws.workspaceId);
    await getPool().query(
      `UPDATE workspaces SET verification_sent_at = now() - make_interval(hours => $2)
        WHERE id = $1`, [ws.workspaceId, TOKEN_TTL_HOURS + 1]);

    const r = await redeemVerification(token);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'expired');
    assert.equal(await isVerified(ws.workspaceId), false);
  });

  // A verification link flips billing state for whoever holds it. It is stored
  // the way an API key is, for the same reason.
  test('the token is never stored in the clear', async () => {
    const ws = await freshWorkspace();
    const token = await issueVerification(ws.workspaceId);
    const { rows } = await getPool().query<{ verification_hash: string }>(
      'SELECT verification_hash FROM workspaces WHERE id = $1', [ws.workspaceId]);
    assert.ok(rows[0]?.verification_hash);
    assert.notEqual(rows[0]!.verification_hash, token);
    assert.equal(rows[0]!.verification_hash.includes(token), false);

    // Left in place after redemption rather than deleted — see redeemVerification.
    // It is inert: all it can do is set a flag that is already set.
    await redeemVerification(token);
    const after = await getPool().query<{ verification_hash: string | null }>(
      'SELECT verification_hash FROM workspaces WHERE id = $1', [ws.workspaceId]);
    assert.ok(after.rows[0]?.verification_hash, 'the token row survives redemption');
  });
});

describe('what the allowance depends on', () => {
  /** meterEffect charges inside the begin() transaction, so give it one. */
  const meterOnce = async (workspaceId: string) => {
    const tx = await getPool().connect();
    try {
      await tx.query('BEGIN');
      const r = await meterEffect(tx, workspaceId, `ef_${randomUUID()}`, new Date());
      await tx.query('COMMIT');
      return r;
    } catch (e) {
      await tx.query('ROLLBACK');
      return e as Error;
    } finally {
      tx.release();
    }
  };

  /**
   * The whole point, stated as behaviour rather than as a column value.
   *
   * The same workspace, at the same usage, is refused before the address
   * answers and served after it — nothing else about it changes.
   */
  test('confirming the address is what lifts the cap', async () => {
    const ws = await freshWorkspace(false);
    await unverify(ws.workspaceId);
    await setPeriodDecisions(ws.workspaceId, ANONYMOUS_EFFECT_QUOTA);

    const refused = await meterOnce(ws.workspaceId);
    assert.ok(refused instanceof Error, 'unverified, at the cap, must be refused');
    assert.equal(refused.name, 'AnonymousQuotaExhausted');

    // One click. Nothing else about the workspace is different.
    const token = await issueVerification(ws.workspaceId);
    await redeemVerification(token);

    const served = await meterOnce(ws.workspaceId);
    assert.ok(!(served instanceof Error), 'confirmed, the free plan applies');
  });

  /**
   * The part that would have caused an outage.
   *
   * Every workspace claimed before this shipped had no verified address. Without
   * the backfill they would all silently drop from the free plan to 100 effects
   * the moment it deployed — including the one running our own uptime probe.
   *
   * Written against the migration's own statement rather than by surveying the
   * table, because a survey passes or fails on whatever earlier tests happened
   * to leave behind. This reconstructs a pre-migration row and re-runs the
   * backfill over it.
   */
  test('a workspace claimed before this existed is grandfathered, not demoted', async () => {
    const ws = await freshWorkspace(false);
    // Exactly how the row looked the moment before migration 028 ran.
    await getPool().query(
      `UPDATE workspaces SET email_verified_at = NULL, claimed_at = now() - interval '30 days'
        WHERE id = $1`, [ws.workspaceId]);

    const backfill = readFileSync(
      new URL('../../src/db/migrations/028_email_verification.sql', import.meta.url), 'utf8');
    const stmt = backfill.split(';').find((q) => /^\s*UPDATE workspaces/m.test(q));
    assert.ok(stmt, 'the migration must still contain the grandfathering statement');
    await getPool().query(stmt);

    assert.equal(await isVerified(ws.workspaceId), true, 'an existing customer keeps their plan');

    // And dated to when they actually joined, not to the day we deployed.
    const { rows } = await getPool().query<{ same: boolean }>(
      'SELECT email_verified_at = claimed_at AS same FROM workspaces WHERE id = $1',
      [ws.workspaceId]);
    assert.equal(rows[0]!.same, true);
  });

  /**
   * Two states, one ceiling, opposite instructions. Telling somebody who has
   * already given us their address to go and give us their address reads as a
   * broken product rather than as one remaining click.
   */
  test('the refusal tells each state what to actually do', async () => {
    const { AnonymousQuotaExhausted } = await import('../../src/domain/metering.js');

    const unconfirmed = new AnonymousQuotaExhausted(100, true);
    assert.equal(unconfirmed.claimed, true);

    const anonymous = new AnonymousQuotaExhausted(100, false);
    assert.equal(anonymous.claimed, false);

    // And the flag actually reaches the caller through begin().
    const ws = await freshWorkspace(false);
    await unverify(ws.workspaceId);
    await setPeriodDecisions(ws.workspaceId, ANONYMOUS_EFFECT_QUOTA);
    const refused = await meterOnce(ws.workspaceId);
    assert.ok(refused instanceof Error);
    assert.equal((refused as InstanceType<typeof AnonymousQuotaExhausted>).claimed, true,
      'a claimed workspace must be told to confirm, not to claim again');
  });

  test('the backfill does not hand a plan to anything unclaimed', async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM workspaces
        WHERE anonymous = true AND email_verified_at IS NOT NULL`);
    assert.equal(Number(rows[0]!.n), 0,
      'nothing unclaimed should have been marked verified');
  });
});
