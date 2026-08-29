import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Strict production-shaped configuration. Must be set before any module reads
// it, so this lives in its own file rather than alongside the loopback tests.
process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK = 'false';

const { freshWorkspace, closePool, getPool } = await import('../helpers.js');
const { deliverDue } = await import('../../src/worker/webhooks.js');
const { enqueueEvent } = await import('../../src/domain/events.js');
const { withTx } = await import('../../src/db/pool.js');
const { newId } = await import('../../src/lib/ids.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(false); });
after(async () => { await closePool(); });

/**
 * Insert the endpoint row directly, deliberately bypassing the API's
 * registration-time validation. That proves the guard also runs at delivery
 * time — which is what actually matters, since a hostname can be repointed at
 * an internal address long after it was registered.
 */
async function plantEndpoint(url: string): Promise<string> {
  const id = newId('whe');
  await getPool().query(
    `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events)
     VALUES ($1,$2,$3,'s',ARRAY['effect.succeeded'])`,
    [id, ws.workspaceId, url]);
  return id;
}

describe('SSRF protection at delivery time', () => {
  const targets: Array<[string, string]> = [
    ['http://169.254.169.254/latest/meta-data/', 'cloud instance metadata'],
    ['http://127.0.0.1:9/admin', 'loopback'],
    ['https://10.0.0.5/internal', 'private class A'],
    ['https://192.168.1.1/router', 'private class C'],
    ['https://172.16.0.1/internal', 'private class B'],
    ['http://[::1]:9/admin', 'IPv6 loopback'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'GCP metadata hostname'],
  ];

  for (const [url, label] of targets) {
    test(`refuses ${label} without contacting it`, async () => {
      const id = await plantEndpoint(url);
      await withTx((tx) => enqueueEvent(tx, ws.workspaceId, 'effect.succeeded', { u: url }));
      await deliverDue();

      const { rows } = await getPool().query(
        'SELECT state, last_error, last_status FROM webhook_deliveries WHERE endpoint_id=$1', [id]);
      assert.equal(rows[0].state, 'dead',
        `${url} must be dead-lettered, not retried against an internal host`);
      assert.match(rows[0].last_error, /unsafe destination/);
      assert.equal(rows[0].last_status, null, 'no request may have been made at all');

      await getPool().query('UPDATE webhook_endpoints SET disabled_at=now() WHERE id=$1', [id]);
    });
  }

  test('a plain-http public destination is refused when https is required', async () => {
    const id = await plantEndpoint('http://example.com/hook');
    await withTx((tx) => enqueueEvent(tx, ws.workspaceId, 'effect.succeeded', { n: 'http' }));
    await deliverDue();
    const { rows } = await getPool().query(
      'SELECT state, last_error FROM webhook_deliveries WHERE endpoint_id=$1', [id]);
    assert.equal(rows[0].state, 'dead');
    assert.match(rows[0].last_error, /unsafe destination/);
  });
});
