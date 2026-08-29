import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setupDb, closePool, keyWithScopes, expireLease } from '../helpers.js';

const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace } = await import('../../src/domain/auth.js');
const { MCP_TOOLS } = await import('../../src/mcp/tools.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let apiKey: string;
let workspaceId: string;

before(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.ready();
  const ws = await createWorkspace('MCP Co', 'mcp@example.test');
  apiKey = ws.key.plaintext;
  workspaceId = ws.workspaceId;
});
after(async () => { await app.close(); await closePool(); });

let nextId = 1;
async function rpc(method: string, params?: unknown, key = apiKey) {
  const res = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) },
  });
  return { status: res.statusCode, body: JSON.parse(res.payload) };
}

const call = async (name: string, args: Record<string, unknown> = {}, key = apiKey) => {
  const r = await rpc('tools/call', { name, arguments: args }, key);
  return { isError: r.body.result?.isError, data: r.body.result?.structuredContent, raw: r };
};

describe('MCP handshake and discovery', () => {
  test('initialize negotiates a protocol version and ships usage instructions', async () => {
    const r = await rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.protocolVersion, '2025-06-18');
    assert.equal(r.body.result.serverInfo.name, 'ratchet');
    assert.match(r.body.result.instructions, /at most once/);
    assert.match(r.body.result.instructions, /idempotency keys/i);
  });

  test('an older protocol version is honoured rather than rejected', async () => {
    const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(r.body.result.protocolVersion, '2024-11-05');
  });

  test('tools/list matches the published tool definitions', async () => {
    const r = await rpc('tools/list');
    const names = r.body.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, MCP_TOOLS.map((t) => t.name).sort());
    for (const t of r.body.result.tools) {
      assert.ok(t.inputSchema, `${t.name} must publish an input schema`);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 80, `${t.name} needs a description an LLM can act on`);
      assert.ok(t.annotations, `${t.name} must declare annotations`);
    }
  });

  test('the manifest tool list cannot drift from the server', async () => {
    const manifest = JSON.parse(
      (await app.inject({ url: '/.well-known/agent-manifest.json' })).payload);
    const info = JSON.parse((await app.inject({ url: '/mcp/info' })).payload);
    const fromList = (await rpc('tools/list')).body.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(manifest.mcp.tools.map((t: any) => t.name).sort(), fromList);
    assert.deepEqual(info.tools.map((t: any) => t.name).sort(), fromList);
  });

  test('notifications receive no response, and ping works', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual((await rpc('ping')).body.result, {});
  });

  test('an unknown method returns a JSON-RPC error, not a crash', async () => {
    const r = await rpc('does/not/exist');
    assert.equal(r.body.error.code, -32601);
  });
});

describe('MCP authentication', () => {
  test('an unauthenticated call is refused and advertises how to authenticate', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(res.statusCode, 401);
    assert.match(res.headers['www-authenticate'] as string, /Bearer/);
  });

  test('a bad key is refused', async () => {
    const r = await rpc('tools/list', undefined, 'rk_test_000000000000_' + 'x'.repeat(32));
    assert.equal(r.status, 401);
  });

  test('scopes are enforced on tool calls', async () => {
    const ro = await keyWithScopes(workspaceId, ['effects:read']);
    const denied = await call('ratchet_begin_effect',
      { effect_type: 'email.send', idempotency_key: 'mcp-scope' }, ro.plaintext);
    assert.equal(denied.isError, true);
    assert.equal(denied.data.error.code, 'forbidden');

    const allowed = await call('ratchet_list_effects', {}, ro.plaintext);
    assert.equal(allowed.isError, false);
  });
});

describe('MCP core loop', () => {
  test('begin returns an explicit next_step the model can follow', async () => {
    const a = await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: 'mcp:1',
      payload: { to: 'x@y.test' }, estimated_cost_micros: 100,
      agent_id: 'claude', run_id: 'run-mcp',
    });
    assert.equal(a.data.decision, 'execute');
    assert.match(a.data.next_step, /Perform the side effect/);
    assert.ok(a.data.lease_token);

    const rep = await call('ratchet_report_effect', {
      effect_id: a.data.effect_id, lease_token: a.data.lease_token,
      outcome: 'succeeded', result: { id: 'm1' },
    });
    assert.equal(rep.data.state, 'succeeded');

    const dup = await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: 'mcp:1', payload: { to: 'x@y.test' },
    });
    assert.equal(dup.data.decision, 'duplicate');
    assert.match(dup.data.next_step, /^STOP/,
      'a duplicate must tell the model to stop in the first word');
    assert.deepEqual(dup.data.result, { id: 'm1' });
  });

  test('every non-execute decision begins its guidance with STOP', async () => {
    const inflight = await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: 'mcp:inflight' });
    assert.equal(inflight.data.decision, 'execute');
    const second = await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: 'mcp:inflight' });
    assert.equal(second.data.decision, 'in_flight');
    assert.match(second.data.next_step, /^STOP/);

    await expireLease(inflight.data.effect_id);
    const blocked = await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: 'mcp:inflight' });
    assert.equal(blocked.data.decision, 'blocked');
    assert.match(blocked.data.next_step, /^STOP/);
    assert.equal(blocked.data.lease_token, undefined);
  });

  test('check_effect never authorises an action', async () => {
    const miss = await call('ratchet_check_effect',
      { effect_type: 'email.send', idempotency_key: 'never-seen' });
    assert.equal(miss.data.found, false);
    assert.match(miss.data.note, /does NOT authorise/);
    assert.equal('lease_token' in miss.data, false);

    const hit = await call('ratchet_check_effect',
      { effect_type: 'email.send', idempotency_key: 'mcp:1' });
    assert.equal(hit.data.found, true);
    assert.equal(hit.data.state, 'succeeded');
    assert.equal('lease_token' in hit.data, false,
      'a read-only tool must never hand out a lease');
  });

  test('resolve settles an indeterminate effect and restores normal semantics', async () => {
    const a = await call('ratchet_begin_effect', {
      effect_type: 'payment.charge', idempotency_key: 'mcp:pay:1',
      payload: { cents: 100 } });
    await expireLease(a.data.effect_id);
    const blocked = await call('ratchet_begin_effect', {
      effect_type: 'payment.charge', idempotency_key: 'mcp:pay:1', payload: { cents: 100 } });
    assert.equal(blocked.data.decision, 'blocked');

    await call('ratchet_resolve_effect', {
      effect_id: a.data.effect_id, outcome: 'succeeded',
      evidence: 'stripe dashboard shows ch_abc', result: { charge: 'ch_abc' } });

    const after = await call('ratchet_begin_effect', {
      effect_type: 'payment.charge', idempotency_key: 'mcp:pay:1', payload: { cents: 100 } });
    assert.equal(after.data.decision, 'duplicate');
    assert.deepEqual(after.data.result, { charge: 'ch_abc' });
  });

  test('list_effects surfaces unresolved work for an operator', async () => {
    const r = await call('ratchet_list_effects', { state: 'indeterminate' });
    assert.ok(Array.isArray(r.data.effects));
    assert.ok(r.data.effects.every((e: any) => e.state === 'indeterminate'));
  });

  test('policy and usage tools report truthfully', async () => {
    const p = await call('ratchet_get_policy', { effect_type: 'payment.charge' });
    assert.equal(p.data.on_indeterminate, 'probe');
    assert.equal(p.data.is_default, false);

    const unknown = await call('ratchet_get_policy', { effect_type: 'never.configured' });
    assert.equal(unknown.data.is_default, true);
    assert.equal(unknown.data.on_indeterminate, 'block',
      'an unconfigured effect type must default to the safe behaviour');

    const u = await call('ratchet_usage');
    assert.equal(u.data.plan, 'free');
    assert.ok(u.data.effects_used_this_period > 0);
    assert.equal(typeof u.data.included_remaining, 'number');
  });

  test('a tool failure is returned as a readable result, not a protocol error', async () => {
    const r = await call('ratchet_report_effect', {
      effect_id: 'eff_nope', lease_token: 'lt_nope', outcome: 'succeeded' });
    assert.equal(r.raw.status, 200, 'a domain failure must not break the JSON-RPC channel');
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'not_found');
  });

  test('a batch of requests is answered as a batch', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${apiKey}` },
      payload: [
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
      ],
    });
    const body = JSON.parse(res.payload);
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 2, 'notifications must not produce responses');
    assert.deepEqual(body.map((m: any) => m.id), ['a', 'b']);
  });
});

describe('MCP stdio transport', () => {
  test('a spawned stdio server completes a handshake and a tool call', async () => {
    const child = spawn('npx', ['tsx', 'src/mcp/stdio.ts'], {
      env: { ...process.env, RATCHET_API_KEY: apiKey, LOG_LEVEL: 'silent' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines: any[] = [];
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) lines.push(JSON.parse(line));
      }
    });

    const waitFor = async (id: string | number, ms = 25000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const found = lines.find((l) => l.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for response ${id}`);
    };

    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      }) + '\n');
      const init = await waitFor(1);
      assert.equal(init.result.serverInfo.name, 'ratchet');

      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      assert.equal((await waitFor(2)).result.tools.length, MCP_TOOLS.length);

      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'ratchet_begin_effect',
                  arguments: { effect_type: 'email.send', idempotency_key: 'stdio:1' } },
      }) + '\n');
      const called = await waitFor(3);
      assert.equal(called.result.structuredContent.decision, 'execute');
    } finally {
      child.stdin.end();
      child.kill();
    }
  });
});
