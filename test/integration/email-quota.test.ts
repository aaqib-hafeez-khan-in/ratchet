/**
 * A spent sending quota must not destroy mail.
 *
 * On 2 Sep 2026 it did: the uptime probe mailed on every failing check, spent
 * the day's quota, and two customers' welcome mail — carrying the links that
 * verify their accounts — was refused and then thrown away inside the hour. The
 * retry ladder tops out at thirty minutes and gives up after five attempts; a
 * daily quota does not reset for up to a day.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { queueEmail, emailQueueHealth } = await import('../../src/domain/email.js');
const { deliverEmails } = await import('../../src/worker/email.js');

let wsId: string;
before(async () => {
  await setupDb();
  const { createWorkspace } = await import('../../src/domain/auth.js');
  const ws = await createWorkspace('quota', `quota-${Date.now()}@example.test`);
  wsId = ws.workspaceId;
});
after(async () => { await closePool(); });

beforeEach(async () => {
  // deliverEmails claims the oldest queued rows across every workspace — it is a
  // worker loop, not a per-tenant call — so leftovers from other files would fill
  // the batch and this file's row would never be tried.
  await getPool().query('DELETE FROM email_messages');
  // A suppressed address stops queueEmail entirely, and one test above earns a
  // suppression on purpose. Without this, every test after it silently queues
  // nothing and asserts against an empty table.
  await getPool().query(
    'UPDATE workspaces SET email_suppressed_at = NULL WHERE id = $1', [wsId]);
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_API_KEY;
});

/** Stand in for the provider, so no test ever touches a real one. */
const withProvider = async (handler: (url: string) => Response, fn: () => Promise<void>) => {
  const real = globalThis.fetch;
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.EMAIL_API_KEY = 'test-key';
  globalThis.fetch = (async (url: string | URL) => handler(String(url))) as typeof fetch;
  try { await fn(); } finally { globalThis.fetch = real; }
};

const quotaSpent = () => new Response(
  JSON.stringify({ message: 'You have reached your daily email sending quota.' }),
  { status: 429, headers: { 'content-type': 'application/json' } });

const row = async () => (await getPool().query(
  `SELECT state, attempts, deferrals, next_attempt_at, last_error
     FROM email_messages WHERE workspace_id = $1`, [wsId])).rows[0];

describe('a spent quota parks mail instead of killing it', () => {
  test('the message survives, and waits past the quota reset', async () => {
    await queueEmail({ workspaceId: wsId, category: 'welcome',
      dedupeKey: `k-${Date.now()}-${Math.random()}`, subject: 's', text: 't' });

    await withProvider(quotaSpent, async () => { await deliverEmails(); });

    const m = await row();
    assert.equal(m.state, 'queued', 'a temporary refusal must not be fatal');
    assert.equal(m.deferrals, 1);
    // Nothing was offered to the recipient, so no attempt was spent on them.
    assert.equal(m.attempts, 0, 'a deferral is a wait, not a delivery attempt');
    const waitHours = (new Date(m.next_attempt_at).getTime() - Date.now()) / 3_600_000;
    assert.ok(waitHours > 0, `should wait, got ${waitHours}h`);
    assert.ok(waitHours <= 24.5, `should not wait past the next reset, got ${waitHours}h`);
  });

  test('five quota days do not exhaust the retries a real failure needs', async () => {
    await queueEmail({ workspaceId: wsId, category: 'welcome',
      dedupeKey: `k-${Date.now()}-${Math.random()}`, subject: 's', text: 't' });
    for (let i = 0; i < 5; i += 1) {
      await getPool().query(
        'UPDATE email_messages SET next_attempt_at = now() WHERE workspace_id = $1', [wsId]);
      await withProvider(quotaSpent, async () => { await deliverEmails(); });
    }
    const m = await row();
    assert.equal(m.state, 'queued');
    assert.equal(m.deferrals, 5);
    assert.equal(m.attempts, 0, 'the retry budget is for transport failures, not our own quota');
  });

  test('but it does not wait for ever', async () => {
    await queueEmail({ workspaceId: wsId, category: 'welcome',
      dedupeKey: `k-${Date.now()}-${Math.random()}`, subject: 's', text: 't' });
    for (let i = 0; i < 8; i += 1) {
      await getPool().query(
        'UPDATE email_messages SET next_attempt_at = now() WHERE workspace_id = $1', [wsId]);
      await withProvider(quotaSpent, async () => { await deliverEmails(); });
    }
    const m = await row();
    assert.equal(m.state, 'dead', 'a week-old unread notification is stale, and the operator has a real problem');
  });

  test('ordinary throttling is still ordinary — minutes, not a day', async () => {
    await queueEmail({ workspaceId: wsId, category: 'welcome',
      dedupeKey: `k-${Date.now()}-${Math.random()}`, subject: 's', text: 't' });
    await withProvider(
      () => new Response(JSON.stringify({ message: 'Too many requests. Please slow down.' }),
        { status: 429, headers: { 'content-type': 'application/json' } }),
      async () => { await deliverEmails(); });

    const m = await row();
    assert.equal(m.state, 'queued');
    assert.equal(m.deferrals, 0, 'a per-second rate limit is not a quota');
    assert.equal(m.attempts, 1, 'and it does count as an attempt');
    const waitMinutes = (new Date(m.next_attempt_at).getTime() - Date.now()) / 60_000;
    assert.ok(waitMinutes < 60, `expected a short backoff, got ${waitMinutes}m`);
  });

  test('a bad address still dies immediately — nothing here rescues a wrong one', async () => {
    await queueEmail({ workspaceId: wsId, category: 'welcome',
      dedupeKey: `k-${Date.now()}-${Math.random()}`, subject: 's', text: 't' });
    await withProvider(
      () => new Response(JSON.stringify({ message: 'The email address is not a valid address.' }),
        { status: 422, headers: { 'content-type': 'application/json' } }),
      async () => { await deliverEmails(); });
    const m = await row();
    assert.equal(m.state, 'suppressed');
  });
});

describe('and the operator can see it', () => {
  test('deferred mail is reported, because nothing else reports it', async () => {
    await queueEmail({ workspaceId: wsId, category: 'welcome',
      dedupeKey: `k-${Date.now()}-${Math.random()}`, subject: 's', text: 't' });
    assert.equal((await emailQueueHealth()).deferred, 0);

    await withProvider(quotaSpent, async () => { await deliverEmails(); });

    const h = await emailQueueHealth();
    assert.equal(h.deferred, 1, 'the API, worker and database are all healthy while this is true');
    assert.equal(h.queued, 1);
  });

  test('the metrics endpoint carries it, with no address in sight', async () => {
    await queueEmail({ workspaceId: wsId, category: 'welcome',
      dedupeKey: `k-${Date.now()}-${Math.random()}`, subject: 's', text: 't' });
    await withProvider(quotaSpent, async () => { await deliverEmails(); });

    const { collect, render } = await import('../../src/domain/operational-metrics.js');
    const text = render(await collect());
    assert.match(text, /ratchet_email_queue\{state="deferred"\} 1/);
    assert.equal(text.includes('secret@example.test'), false);
    assert.equal(text.includes(wsId), false);
  });
});
