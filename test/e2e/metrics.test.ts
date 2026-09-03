/**
 * Operating metrics, and the two things that would make them a liability.
 *
 * A metrics endpoint is the classic place a multi-tenant service leaks its
 * customer list, and these numbers end up inside a third-party monitoring
 * vendor by design. So the tests are mostly about what must NOT be in the
 * output, and about the endpoint being invisible until it is configured.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TOKEN = 'metrics-token-for-tests-0123456789';
process.env.METRICS_TOKEN = TOKEN;
process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, freshWorkspace } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { render } = await import('../../src/domain/operational-metrics.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); delete process.env.METRICS_TOKEN; });

const scrape = (token?: string) => app.inject({
  method: 'GET', url: '/metrics',
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

describe('who can read it', () => {
  test('a correct token gets Prometheus text', async () => {
    const r = await scrape(TOKEN);
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'] as string, /text\/plain/);
    assert.match(r.payload, /^# HELP ratchet_effects_total/m);
    assert.match(r.payload, /^# TYPE ratchet_effects_total gauge$/m);
  });

  /**
   * 404, not 401. A 401 confirms the endpoint exists and is worth attacking;
   * on a public domain with a public repository that is a free hint.
   */
  test('no token is a 404, not a 401', async () => {
    const r = await scrape();
    assert.equal(r.statusCode, 404);
    assert.equal(r.payload.includes('ratchet_'), false, 'a refusal must not leak a sample');
  });

  test('a wrong token of the same length is also a 404', async () => {
    const r = await scrape('x'.repeat(TOKEN.length));
    assert.equal(r.statusCode, 404);
  });

  test('a truncated token does not pass', async () => {
    const r = await scrape(TOKEN.slice(0, TOKEN.length - 1));
    assert.equal(r.statusCode, 404);
  });
});

describe('what it must never contain', () => {
  /**
   * The failure that matters. A label like workspace_id="ws_abc" hands the
   * shape of the business to whoever runs the monitoring, and cannot be
   * un-sent once it is in a vendor's storage.
   */
  test('no workspace, key, or customer identifier appears anywhere', async () => {
    const ws = await freshWorkspace(false);
    const body = (await scrape(TOKEN)).payload;

    assert.equal(body.includes(ws.workspaceId), false, 'a workspace id is in the metrics output');
    assert.equal(body.includes(ws.key.prefix), false, 'an API key prefix is in the metrics output');
    for (const forbidden of ['workspace_id', 'workspace=', 'key_prefix', 'cus_', 'rk_']) {
      assert.equal(body.includes(forbidden), false,
        `"${forbidden}" appears in the metrics output — metrics are aggregates only`);
    }
    // "email" used to be on that list, standing in for an address. It banned the
    // word rather than the thing, so the mail-queue gauge — which is exactly the
    // sort of aggregate this endpoint is for — could not be published. Ban the
    // address instead, which is both narrower and stronger.
    assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(body), false,
      'an email address is in the metrics output');
  });

  test('the token is never echoed back', async () => {
    const body = (await scrape(TOKEN)).payload;
    assert.equal(body.includes(TOKEN), false);
  });
});

describe('the shape of the output', () => {
  /**
   * A gauge that vanishes at zero leaves a gap in a graph rather than a flat
   * line, and an alert on absent() then fires for a system that is fine.
   */
  test('every effect state is emitted even when nothing is in it', () => {
    const body = render({
      effectsByState: { succeeded: 3 },
      effectsCreated: { lastHour: 0, lastDay: 3 },
      indeterminate: { lastHour: 0, lastDay: 0 },
      leasesOutstanding: 0, awaitingApproval: 0,
      webhooks: { pending: 0, failed: 0, deliveredLastDay: 0 },
      email: { queued: 0, deferred: 0, deadLastDay: 0 },
      circuitsOpen: 0, workers: { loops: 4, stale: 0 }, replicas: null,
      keysByPepper: [],
    });
    for (const state of ['pending', 'succeeded', 'failed', 'indeterminate',
                         'denied', 'cancelled', 'awaiting_approval']) {
      assert.match(body, new RegExp(`ratchet_effects_total\\{state="${state}"\\}`),
        `${state} disappears from the output when it is zero`);
    }
  });

  /**
   * On a standby, replication is genuinely unobservable. Reporting zero lag
   * from the one place that cannot see is how a dashboard reports health it
   * has no basis for.
   */
  test('replication series are omitted rather than reported as zero when unobservable', () => {
    const base = {
      effectsByState: {}, effectsCreated: { lastHour: 0, lastDay: 0 },
      indeterminate: { lastHour: 0, lastDay: 0 },
      leasesOutstanding: 0, awaitingApproval: 0,
      webhooks: { pending: 0, failed: 0, deliveredLastDay: 0 },
      email: { queued: 0, deferred: 0, deadLastDay: 0 },
      circuitsOpen: 0, workers: { loops: 1, stale: 0 },
      keysByPepper: [],
    };
    assert.equal(render({ ...base, replicas: null }).includes('ratchet_replica_lag_bytes'), false);
    assert.match(render({ ...base, replicas: { connected: 2, maxLagBytes: 512 } }),
      /ratchet_replica_lag_bytes 512/);
  });

  test('the indeterminate rate is exposed, since it is the number to alert on', async () => {
    const body = (await scrape(TOKEN)).payload;
    assert.match(body, /ratchet_effects_indeterminate\{window="1h"\}/);
    assert.match(body, /ratchet_effects_indeterminate\{window="24h"\}/);
    assert.match(body, /leading indicator/, 'the HELP text should say why it matters');

    // A lifetime total only climbs. An alert on it fires once and stays lit,
    // and it reads high on any instance that has ever been load-tested — which
    // is exactly what happened here.
    assert.equal(/ratchet_effects_indeterminate\{window="all"\}/.test(body), false,
      'a cumulative series invites alerting on a number that never recovers');
  });
});
