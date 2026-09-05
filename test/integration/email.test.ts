// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.EMAIL_PROVIDER = 'log';

const { freshWorkspace, closePool, getPool, expireLease } = await import('../helpers.js');
const { queueEmail, setPreference, getPreferences, bucket, suppressAddress } =
  await import('../../src/domain/email.js');
const { deliverEmails, generateAlerts } = await import('../../src/worker/email.js');
const { beginEffect } = await import('../../src/domain/effects.js');
const { sweepExpiredLeases, drainExpiredLeases } = await import('../../src/worker/reaper.js');
const { createWorkspace } = await import('../../src/domain/auth.js');
const { openManually } = await import('../../src/domain/circuit.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(false); });
after(async () => { mock.restoreAll(); await closePool(); });

const inbox = async (workspaceId = ws.workspaceId) => (await getPool().query(
  'SELECT category, subject, state, dedupe_key FROM email_messages WHERE workspace_id=$1 ORDER BY created_at',
  [workspaceId])).rows;

const clear = async () => { await getPool().query('DELETE FROM email_messages'); };

describe('queueing and de-duplication', () => {
  test('a message is queued once and repeats collapse', async () => {
    await clear();
    const args = { workspaceId: ws.workspaceId, category: 'usage' as const,
                   dedupeKey: 'same-window', subject: 'Hello', text: 'body' };
    assert.equal((await queueEmail(args)).queued, true);
    for (let i = 0; i < 5; i++) {
      const r = await queueEmail(args);
      assert.equal(r.queued, false);
      assert.equal(r.reason, 'already queued in this window');
    }
    assert.equal((await inbox()).length, 1);
  });

  test('a different window queues again', async () => {
    await clear();
    await queueEmail({ workspaceId: ws.workspaceId, category: 'usage', dedupeKey: 'usage:1',
                       subject: 'a', text: 'a' });
    await queueEmail({ workspaceId: ws.workspaceId, category: 'usage', dedupeKey: 'usage:2',
                       subject: 'b', text: 'b' });
    assert.equal((await inbox()).length, 2);
  });

  test('the time bucket advances only when the window does', () => {
    const t = new Date('2026-08-30T10:00:00Z');
    assert.equal(bucket(60, t), bucket(60, new Date('2026-08-30T10:59:00Z')),
      'same hour, same bucket');
    assert.notEqual(bucket(60, t), bucket(60, new Date('2026-08-30T11:00:00Z')));
  });
});

describe('a storm collapses into one email', () => {
  test('many indeterminate effects produce a single message', async () => {
    await clear();
    // Twenty effects abandoned mid-flight — the exact situation that would
    // otherwise mean twenty emails and a spam folder.
    for (let i = 0; i < 20; i++) {
      const r = await beginEffect({
        workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
        keyDailyBudgetMicros: null, effectType: i % 2 ? 'email.send' : 'payment.charge',
        idempotencyKey: `storm-${i}`, payload: { i }, estimatedCostMicros: 0, leaseSeconds: 5,
      });
      await expireLease(r.effectId);
    }
    await sweepExpiredLeases(50);

    await generateAlerts();
    await generateAlerts();          // a second pass must add nothing
    await generateAlerts();

    const sent = (await inbox()).filter((m) => m.category === 'indeterminate');
    assert.equal(sent.length, 1, '20 effects, 3 passes, 1 email');
    assert.match(sent[0]!.subject, /20 effects/);
  });

  test('the body says what to do, and leaks no payload', async () => {
    const m = (await getPool().query(
      `SELECT body_text FROM email_messages WHERE workspace_id=$1 AND category='indeterminate'`,
      [ws.workspaceId])).rows[0];
    const body: string = m.body_text;
    assert.match(body, /may or may not have happened/);
    assert.match(body, /check the vendor/i);
    assert.match(body, /payment\.charge|email\.send/, 'names the affected effect types');
    assert.equal(/"payload"|idempotencyKey|rk_live|rk_test/.test(body), false,
      'an email is an unencrypted copy that lives forever — no payloads or keys');
  });
});

describe('preferences', () => {
  test('every category is on by default, so a new alert type still reaches people', async () => {
    const prefs = await getPreferences(getPool(), ws.workspaceId);
    assert.ok(prefs.length >= 5);
    assert.equal(prefs.every((p) => p.enabled), true);
  });

  test('opting out of a category stops it, and only it', async () => {
    await clear();
    await setPreference(ws.workspaceId, 'usage', false);
    const off = await queueEmail({ workspaceId: ws.workspaceId, category: 'usage',
      dedupeKey: 'u1', subject: 'x', text: 'x' });
    assert.equal(off.queued, false);
    assert.equal(off.reason, 'opted out of this category');

    const on = await queueEmail({ workspaceId: ws.workspaceId, category: 'security',
      dedupeKey: 's1', subject: 'y', text: 'y' });
    assert.equal(on.queued, true, 'other categories are unaffected');
    await setPreference(ws.workspaceId, 'usage', true);
  });
});

describe('delivery', () => {
  test('a queued message is sent and marked', async () => {
    await clear();
    await queueEmail({ workspaceId: ws.workspaceId, category: 'security',
      dedupeKey: 'deliver-1', subject: 'Test', text: 'body' });
    assert.equal(await deliverEmails(), 1);
    assert.equal((await inbox())[0]!.state, 'sent');
  });

  test('a transient failure is retried with backoff, not dropped', async () => {
    await clear();
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.EMAIL_API_KEY = 'test-key';
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ message: 'upstream boom' }), { status: 503 }));

    await queueEmail({ workspaceId: ws.workspaceId, category: 'security',
      dedupeKey: 'retry-1', subject: 'Test', text: 'body' });
    await deliverEmails();

    const { rows } = await getPool().query(
      `SELECT state, attempts, next_attempt_at > now() AS scheduled, last_error
         FROM email_messages WHERE dedupe_key='retry-1'`);
    assert.equal(rows[0].state, 'queued');
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].scheduled, true, 'a retry must be scheduled into the future');
    mock.restoreAll();
  });

  test('a permanently bad address is suppressed, protecting the sending domain', async () => {
    await clear();
    const victim = await freshWorkspace(false);
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ message: 'invalid recipient address' }), { status: 422 }));

    await queueEmail({ workspaceId: victim.workspaceId, category: 'security',
      dedupeKey: 'bounce-1', subject: 'Test', text: 'body' });
    await deliverEmails();

    const { rows } = await getPool().query(
      'SELECT email_suppressed_at FROM workspaces WHERE id=$1', [victim.workspaceId]);
    assert.notEqual(rows[0].email_suppressed_at, null,
      'continuing to send to a hard bounce is how a domain gets blocked');

    // And nothing further is queued for that address.
    const after = await queueEmail({ workspaceId: victim.workspaceId, category: 'security',
      dedupeKey: 'bounce-2', subject: 'Test', text: 'body' });
    assert.equal(after.queued, false);
    assert.equal(after.reason, 'address suppressed');
    mock.restoreAll();
    process.env.EMAIL_PROVIDER = 'log';
    delete process.env.EMAIL_API_KEY;
  });

  test('a 4xx that is not a bounce dead-letters rather than retrying forever', async () => {
    await clear();
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.EMAIL_API_KEY = 'test-key';
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ message: 'subject line too long' }), { status: 400 }));
    await queueEmail({ workspaceId: ws.workspaceId, category: 'security',
      dedupeKey: 'dead-1', subject: 'Test', text: 'body' });
    await deliverEmails();
    const { rows } = await getPool().query(
      `SELECT state FROM email_messages WHERE dedupe_key='dead-1'`);
    assert.equal(rows[0].state, 'dead', 'retrying a message the provider will never accept is waste');
    mock.restoreAll();
    process.env.EMAIL_PROVIDER = 'log';
    delete process.env.EMAIL_API_KEY;
  });

  test('emails are workspace-scoped', async () => {
    const other = await freshWorkspace(false);
    assert.equal((await inbox(other.workspaceId)).length, 0);
  });
});

describe('one workspace cannot silence everybody else', () => {
  test('an ownerless workspace is skipped, not fatal', async () => {
    // Anonymous workspaces have no owner address. They are created by the
    // zero-friction path — any unauthenticated begin — and their agents crash
    // like everyone else's, so they accumulate exactly the conditions that
    // generate alerts. queueEmail used to insert NULL into a NOT NULL column,
    // and the exception escaped the sweep: every workspace sorted after it
    // silently stopped receiving alerts. Five such workspaces existed in a
    // development database within a day of the feature shipping.
    const anon = await createWorkspace('anon', null, false, true);
    const r = await queueEmail({
      workspaceId: anon.workspaceId, category: 'indeterminate',
      dedupeKey: `owner-test:${Date.now()}`,
      subject: 'should not send', text: 'should not send',
    });
    assert.equal(r.queued, false);
    assert.match(r.reason ?? '', /no owner/i);

    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM email_messages WHERE workspace_id = $1',
      [anon.workspaceId]);
    assert.equal(rows[0].n, 0, 'nothing may be queued for an address that does not exist');
  });

  test('the alert sweep completes even when one workspace fails', async () => {
    // The guarantee is about ordering: a workspace that fails must not prevent
    // the ones after it from being alerted.
    const anon = await createWorkspace('anon-2', null, false, true);
    const owned = await freshWorkspace();
    for (const w of [anon, owned]) {
      const r = await beginEffect({
        workspaceId: w.workspaceId, apiKeyId: w.key.id, apiKeyPrefix: w.key.prefix,
        keyDailyBudgetMicros: null, effectType: 'sweep.test',
        idempotencyKey: `s-${w.workspaceId}`, payload: {}, estimatedCostMicros: 0,
        leaseSeconds: 5,
      });
      await expireLease(r.effectId);
    }
    await drainExpiredLeases();
    await generateAlerts();

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM email_messages
        WHERE workspace_id = $1 AND category = 'indeterminate'`, [owned.workspaceId]);
    assert.equal(rows[0].n, 1, 'the owned workspace must still be alerted');
  });

  test('an open circuit breaker produces an alert', async () => {
    const ws = await freshWorkspace();
    await openManually(getPool(), ws.workspaceId, '*',
      { action: 'deny', reason: 'agent looping', actor: 'console:owner' });
    await generateAlerts();
    const { rows } = await getPool().query(
      `SELECT subject, body_text FROM email_messages
        WHERE workspace_id = $1 AND category = 'containment'`, [ws.workspaceId]);
    assert.equal(rows.length, 1);
    assert.match(rows[0].subject, /workspace-wide/i);
    assert.match(rows[0].body_text, /agent looping/);
    assert.match(rows[0].body_text, /stays open until you close it/);
  });

  test('a breaker reason cannot inject markup into the email', async () => {
    // Operator-supplied text reaches an HTML email. This codebase has already
    // had one injection bug here; the escaping is not optional.
    const ws = await freshWorkspace();
    await openManually(getPool(), ws.workspaceId, 'inject.test',
      { action: 'deny', reason: '<img src=x onerror=alert(1)>', actor: 'console:owner' });
    await generateAlerts();
    const { rows } = await getPool().query(
      `SELECT body_html FROM email_messages
        WHERE workspace_id = $1 AND category = 'containment'`, [ws.workspaceId]);
    const html: string = rows[0].body_html;
    assert.ok(!/<img src=x/.test(html), 'raw markup must never reach the HTML body');
    assert.match(html, /&lt;img src=x/, 'it should appear escaped instead');
  });
});
