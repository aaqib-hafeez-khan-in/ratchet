import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDb, closePool } from '../helpers.js';

const { buildApp } = await import('../../src/api/app.js');
const { MCP_TOOLS } = await import('../../src/mcp/tools.js');
const { PLANS } = await import('../../src/domain/plans.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const json = async (url: string) => JSON.parse((await app.inject({ url })).payload);

describe('OpenAPI document', () => {
  test('every documented path is actually routable', async () => {
    const spec = await json('/openapi.json');
    // Probe each documented operation with no credentials and an empty body.
    // A registered route answers 401/400/503; only the router's own handler
    // produces "No route for", so that string is the drift signal.
    for (const [path, methods] of Object.entries<any>(spec.paths)) {
      const url = path.replace(/\{(\w+)\}/g, 'probe');
      for (const method of Object.keys(methods)) {
        const res = await app.inject({
          method: method.toUpperCase() as any, url,
          ...(method === 'get' || method === 'delete' ? {} : { payload: {} }),
        });
        assert.equal(res.statusCode === 404 && res.payload.includes('No route for'), false,
          `OpenAPI documents ${method.toUpperCase()} ${path}, but no such route is registered`);
      }
    }
  });

  test('paths are absolute, so root-level endpoints resolve correctly', async () => {
    const spec = await json('/openapi.json');
    // The server is the bare origin; a /v1 server URL would make the emitted
    // paths wrong for /healthz and friends.
    assert.equal(spec.servers[0].url.endsWith('/v1'), false);
    assert.ok(spec.paths['/v1/effects/begin'], 'API paths must carry the /v1 prefix');
    assert.ok(spec.paths['/healthz'], 'root paths must be documented at the root');
  });

  test('the HTML site is not described as API surface', async () => {
    const spec = await json('/openapi.json');
    for (const page of ['/docs', '/console', '/pricing', '/security', '/openapi.json', '/mcp']) {
      assert.equal(page in spec.paths, false, `${page} must not appear in the API spec`);
    }
  });

  test('every operation is named and tagged, and errors are documented', async () => {
    const spec = await json('/openapi.json');
    for (const [path, methods] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(methods)) {
        assert.ok(op.operationId, `${method.toUpperCase()} ${path} needs an operationId`);
        assert.ok(op.tags?.length, `${method.toUpperCase()} ${path} needs a tag`);
        assert.ok(op.summary, `${method.toUpperCase()} ${path} needs a summary`);
      }
    }
    const begin = spec.paths['/v1/effects/begin'].post;
    for (const code of ['400', '401', '402', '403', '409', '429']) {
      assert.ok(begin.responses[code], `begin must document a ${code} response`);
    }
  });

  test('the begin response documents every decision the code can return', async () => {
    const spec = await json('/openapi.json');
    const schema = spec.paths['/v1/effects/begin'].post.responses['200'].content['application/json'].schema;
    assert.deepEqual(
      [...schema.properties.decision.enum].sort(),
      ['approval_required', 'blocked', 'denied', 'duplicate', 'execute', 'in_flight'],
    );
  });
});

describe('agent manifest', () => {
  test('advertised URLs and tools match the running service', async () => {
    const m = await json('/.well-known/agent-manifest.json');

    for (const url of [m.openapi_url, m.llms_txt_url]) {
      const path = new URL(url).pathname;
      assert.equal((await app.inject({ url: path })).statusCode, 200, `${path} must serve`);
    }
    assert.deepEqual(
      m.mcp.tools.map((t: any) => t.name).sort(),
      MCP_TOOLS.map((t) => t.name).sort(),
    );
    assert.equal(m.pricing.free_tier_effects_per_month, PLANS.free.includedEffects,
      'the manifest must not advertise a free tier the code does not grant');
    for (const [id, limit] of Object.entries(m.limits.rate_limit_per_minute_by_plan)) {
      assert.equal(limit, PLANS[id as keyof typeof PLANS].rateLimitPerMinute);
    }
  });

  test('the manifest states what the service does NOT do', async () => {
    const m = await json('/.well-known/agent-manifest.json');
    const text = m.does_not.join(' ').toLowerCase();
    assert.match(text, /execute code|shell/, 'must disclaim arbitrary execution');
    assert.match(text, /exactly-once/, 'must disclaim exactly-once, which is not achievable');
    assert.match(text, /raw payload|only a fingerprint/, 'must state that payloads are not stored');
  });

  /**
   * The manifest must describe the package as it actually is.
   *
   * This test used to assert the note said "not yet published", which was true
   * when it was written and quietly became a false claim on a machine-read
   * surface once the package shipped — agents read this to decide how to
   * install the server, and it was sending them to build from source.
   *
   * It now compares the claim against the repository rather than against a
   * string, so it fails whichever way the two drift apart.
   */
  test('the stdio install hint matches whether the package is actually publishable', async () => {
    const m = await json('/.well-known/agent-manifest.json');
    const note: string = m.mcp.transports.stdio.note;
    const bridge = JSON.parse(readFileSync(
      new URL('../../packages/ratchet-mcp/package.json', import.meta.url), 'utf8'));

    // The command must name the package the repository actually builds.
    assert.deepEqual(m.mcp.transports.stdio.args, ['-y', bridge.name],
      'the install command names a different package than the one in this repo');

    const publishable = bridge.private !== true && typeof bridge.version === 'string';
    if (publishable) {
      assert.equal(/not yet published/i.test(note), false,
        `the manifest calls ${bridge.name} unpublished while this repo publishes it — `
        + 'agents read this to decide how to install, and are being sent the long way round');
    } else {
      assert.match(note, /not yet published/i,
        'a package this repo does not publish must not be advertised as installable');
    }
  });
});

describe('llms.txt', () => {
  test('describes the real decisions and the real endpoints', async () => {
    const body = (await app.inject({ url: '/llms.txt' })).payload;
    for (const decision of ['execute', 'duplicate', 'in_flight', 'blocked',
                            'approval_required', 'denied']) {
      assert.ok(body.includes(decision), `llms.txt must document the "${decision}" decision`);
    }
    for (const path of ['/v1/effects/begin', '/v1/effects/{id}/report', '/v1/effects/{id}/resolve']) {
      assert.ok(body.includes(path), `llms.txt must document ${path}`);
    }
    assert.ok(body.includes(String(PLANS.free.includedEffects.toLocaleString())),
      'the advertised free tier must match the code');
    assert.match(body, /indeterminate/,
      'llms.txt must explain the indeterminate state — it is the core behaviour');
  });
});

describe('published pricing matches the code', () => {
  test('/v1/billing/plans agrees with the plan definitions', async () => {
    const p = await json('/v1/billing/plans');
    for (const plan of p.plans) {
      const real = PLANS[plan.id as keyof typeof PLANS];
      assert.equal(plan.included_effects, real.includedEffects);
      assert.equal(plan.overage_micros_per_effect, real.overageMicrosPerEffect);
      assert.equal(plan.monthly_price_micros, real.monthlyPriceMicros);
    }
  });

  test('billing honestly reports whether it can take real money', async () => {
    const p = await json('/v1/billing/plans');
    const { live, test_mode, note, setup_incomplete } = p.provider;

    // The invariant is honesty in whichever state is configured, not one
    // particular state — this must hold on an operator's machine too.
    assert.equal(typeof note, 'string');
    assert.ok(note.length > 20, 'the provider state must be explained, not just flagged');
    assert.notEqual(live, test_mode, 'live and test_mode must never agree');

    if (setup_incomplete) {
      assert.equal(live, false, 'an incomplete setup is never live');
      assert.match(note, new RegExp(setup_incomplete),
        'the note must name the missing variable');
    } else if (live) {
      assert.match(note, /never reach Ratchet/i,
        'a live provider must state that card details do not reach us');
    } else {
      assert.match(note, /no (real )?(card|money)/i,
        'a non-live provider must state plainly that no money moves');
    }
  });

  test('the test-mode default is what this build ships with', async () => {
    // The suite forces the test adapter (see test/helpers.ts), so this asserts
    // the shipped default rather than whatever the operator has configured.
    const p = await json('/v1/billing/plans');
    assert.equal(p.provider.name, 'test');
    assert.equal(p.provider.live, false);
  });
});
