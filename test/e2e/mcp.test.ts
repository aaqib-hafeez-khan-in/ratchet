// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
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
  // Was tools/list, which is now deliberately open — see "MCP discovery is
  // open, acting is not" below. The property this test exists for is unchanged
  // and still worth pinning: a call that IS refused must say how to
  // authenticate, because that header is how a client bootstraps OAuth.
  test('an unauthenticated call is refused and advertises how to authenticate', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_begin_effect', arguments: {} } } });
    assert.equal(res.statusCode, 401);
    assert.match(res.headers['www-authenticate'] as string, /Bearer/);
  });

  // Was tools/list, which is public now and deliberately does not inspect the
  // credential — see "a placeholder credential does not hide public
  // information" below. The property being pinned is unchanged: a bad key must
  // not buy access to anything that needs one.
  test('a bad key is refused', async () => {
    const r = await rpc('tools/call',
      { name: 'ratchet_begin_effect', arguments: { effect_type: 'x', idempotency_key: 'y' } },
      'rk_test_000000000000_' + 'x'.repeat(32));
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
    const miss = await call('ratchet_get_effect',
      { effect_type: 'email.send', idempotency_key: 'never-seen' });
    assert.equal(miss.data.found, false);
    assert.match(miss.data.note, /does NOT authorise/);
    assert.equal('lease_token' in miss.data, false);

    const hit = await call('ratchet_get_effect',
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

    const u = await call('ratchet_get_usage');
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

/**
 * The prevented-loss endpoint shipped broken because nothing ran its query.
 * These exercise each new tool against a real database for the same reason: a
 * handler whose SQL never executes is a handler that is probably wrong.
 */
describe('proof and reconciliation tools over MCP', () => {
  test('receipts come back verifiable, with the key needed to check them', async () => {
    const key = `mcp-rcpt-${Date.now()}`;
    const begun = await call('ratchet_begin_effect', {
      effect_type: 'payment.charge', idempotency_key: key,
      payload: { a: 1 }, estimated_cost_micros: 4_999_000,
    });
    assert.equal(begun.data.decision, 'execute');

    const r = await call('ratchet_list_receipts', { effect_id: begun.data.effect_id });
    assert.equal(r.isError, false);
    assert.ok(r.data.receipts.length >= 1, 'a decision must leave a receipt');
    assert.ok(r.data.public_key, 'without the key the receipt cannot be checked');

    const { verifyReceipt } = await import('../../src/domain/receipts.js');
    const rec = r.data.receipts[0];
    assert.ok(verifyReceipt(JSON.stringify(rec.body), rec.signature, r.data.public_key),
      'a receipt handed to a model must verify with the key handed alongside it');
  });

  test('an unknown effect says so rather than implying nothing happened', async () => {
    const r = await call('ratchet_list_receipts', { effect_id: 'eff_does_not_exist' });
    assert.equal(r.isError, false);
    assert.deepEqual(r.data.receipts, []);
    // A model must not read an empty list as proof of absence.
    assert.match(r.data.note, /NOT evidence/);
  });

  test('reconcile separates gated actions from ungated ones', async () => {
    const gated = `mcp-recon-${Date.now()}`;
    await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: gated, payload: {},
    });
    const r = await call('ratchet_reconcile_effects', {
      effect_type: 'email.send',
      keys: [gated, 'never-asked-1', 'never-asked-2'],
    });
    assert.equal(r.isError, false);
    assert.equal(r.data.checked, 3);
    assert.equal(r.data.gated, 1);
    assert.equal(r.data.ungated, 2);
    assert.ok(r.data.ungated_keys.includes('never-asked-1'));
    assert.match(r.data.next_step, /without asking/);
  });

  test('reconcile is workspace-scoped', async () => {
    const mine = `mcp-scope-${Date.now()}`;
    await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: mine, payload: {},
    });
    const other = await createWorkspace('Other Co', `other-${Date.now()}@example.test`);
    const r = await call('ratchet_reconcile_effects',
      { effect_type: 'email.send', keys: [mine] }, other.key.plaintext);
    // Another tenant must not learn that this key was gated by someone else.
    assert.equal(r.data.gated, 0);
    assert.equal(r.data.ungated, 1);
  });

  test('prevented loss runs its query and counts refusals', async () => {
    const key = `mcp-prevent-${Date.now()}`;
    const args = {
      effect_type: 'payment.charge', idempotency_key: key,
      payload: {}, estimated_cost_micros: 2_500_000,
    };
    await call('ratchet_begin_effect', args);
    await call('ratchet_begin_effect', args);   // refused

    const r = await call('ratchet_get_prevented_loss');
    assert.equal(r.isError, false);
    assert.ok(r.data.duplicate_actions_refused >= 1);
    assert.ok(Number(r.data.would_have_cost_micros) >= 2_500_000,
      'a declared cost must reach the ledger');
    assert.match(r.data.would_have_cost_usd, /^\d+\.\d{2}$/);
  });

  test('every tool is reachable and none is only a definition', async () => {
    const listed = (await rpc('tools/list')).body.result.tools.map((t: { name: string }) => t.name);
    for (const t of MCP_TOOLS) {
      assert.ok(listed.includes(t.name), `${t.name} is defined but not listed`);
    }
    // A tool that is advertised but throws on every call is worse than absent.
    for (const name of ['ratchet_get_prevented_loss', 'ratchet_get_usage']) {
      const r = await call(name);
      assert.notEqual(r.isError, true, `${name} errored on a plain call`);
    }
  });
});

/**
 * Discovery without a credential.
 *
 * An MCP client connects, calls initialize and tools/list, and only then asks
 * the user for configuration. Answering those with 401 meant the client showed
 * "connection closed" and the user never learned a key was the missing piece.
 * A directory indexing the server reported the same thing and graded us
 * unrated. None of these methods reads tenant data.
 */
describe('MCP discovery is open, acting is not', () => {
  const rpc = (method: string, params?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', ...headers },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });

  for (const method of ['initialize', 'ping', 'tools/list']) {
    test(`${method} needs no credential`, async () => {
      const r = await rpc(method);
      assert.equal(r.statusCode, 200, `${method} should not require auth`);
      assert.ok(!(r.json() as { error?: unknown }).error, `${method} returned an error`);
    });
  }

  test('an unauthenticated tools/list returns the real tools', async () => {
    const r = await rpc('tools/list');
    const tools = (r.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
    assert.ok(tools.length > 0, 'a directory grading this needs the definitions');
    assert.ok(tools.some((t) => t.name === 'ratchet_begin_effect'));
  });

  // The 401 is how a client that has never seen this server discovers where to
  // start an OAuth flow. Turning it into a JSON-RPC error would break that.
  test('tools/call still answers 401 with the OAuth challenge', async () => {
    const r = await rpc('tools/call', { name: 'ratchet_begin_effect', arguments: {} });
    assert.equal(r.statusCode, 401);
    assert.match(String(r.headers['www-authenticate']), /resource_metadata=/);
  });

  test('a batch mixing public and private methods is refused as a whole', async () => {
    const r = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
      ],
    });
    assert.equal(r.statusCode, 401, 'a private method in the batch must require auth');
  });

  test('an anonymous caller is given no session id', async () => {
    const r = await rpc('tools/list');
    assert.equal(r.headers['mcp-session-id'], undefined,
      'there is no workspace to name, so none may be implied');
  });

  test('an invalid key is still rejected, not treated as anonymous', async () => {
    const r = await rpc('tools/call', { name: 'ratchet_begin_effect', arguments: {} },
      { authorization: 'Bearer rk_live_totallyinvalid' });
    assert.equal(r.statusCode, 401);
  });
});

/**
 * Directories and scanners start a server by handing it a dummy credential —
 * Glama's build form fills one in by default. Refusing discovery in that case
 * made the whole open-discovery change useless for the situation it was written
 * for, and protected nothing: these methods return the same bytes for everyone.
 */
describe('a placeholder credential does not hide public information', () => {
  const withKey = (method: string, key: string, params?: unknown) =>
    app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });

  for (const bogus of ['rat_live_8f3b2a9c1d7e4f6a8b0c2d3e4f5a6b7c', 'placeholder', 'rk_live_nope']) {
    test(`tools/list still answers with "${bogus.slice(0, 12)}…"`, async () => {
      const r = await withKey('tools/list', bogus);
      assert.equal(r.statusCode, 200);
      const tools = (r.json() as { result: { tools: unknown[] } }).result.tools;
      assert.ok(tools.length > 0);
    });
  }

  test('initialize too, so a scanner completes the handshake', async () => {
    const r = await withKey('initialize', 'rat_live_dummy');
    assert.equal(r.statusCode, 200);
  });

  // The line that must not move.
  test('but a placeholder still cannot call a tool', async () => {
    const r = await withKey('tools/call', 'rat_live_dummy',
      { name: 'ratchet_begin_effect', arguments: {} });
    assert.equal(r.statusCode, 401);
  });
});

/**
 * Memory and wallet, over the wire.
 *
 * The domain is covered in test/integration/recall.test.ts. What is asserted
 * here is the boundary that makes the wallet mean anything: an agent may read
 * what it has left, and may not raise it. If those two facts ever swap, the
 * ceiling becomes decoration and nothing else in the design matters.
 */
describe('a run has a memory and a wallet', () => {
  test('recall is a tool an agent can call, and comes back grouped', async () => {
    const run = `mcp-run-${Date.now()}`;
    const begun = await call('ratchet_begin_effect', {
      effect_type: 'email.send', idempotency_key: `${run}-1`, run_id: run,
    });
    assert.equal(begun.isError, false, 'begin should succeed');

    const r = await call('ratchet_get_run', { run_id: run });
    assert.equal(r.isError, false);
    assert.equal(r.data?.run_id, run);
    assert.equal(r.data?.steps, 1);
    // Begun and not reported, so it is in flight rather than done.
    assert.equal((r.data?.in_flight as unknown[]).length, 1);
    assert.match(String(r.data?.next), /in flight/);
  });

  test('an agent cannot raise its own ceiling', async () => {
    // The default agent scopes are begin, report and read — deliberately not
    // policies:write. This is the whole control.
    const agent = (await keyWithScopes(workspaceId,
      ['effects:begin', 'effects:report', 'effects:read'])).plaintext;
    const run = `mcp-cap-${Date.now()}`;

    const r = await app.inject({
      method: 'PUT', url: `/v1/runs/${run}/budget`,
      headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' },
      payload: { limit_micros: 999_000_000 },
    });
    assert.equal(r.statusCode, 403,
      'an agent that can raise its own budget has no budget');
  });

  test('but it can read what it has left', async () => {
    const run = `mcp-read-${Date.now()}`;
    const set = await app.inject({
      method: 'PUT', url: `/v1/runs/${run}/budget`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { limit_micros: 250_000 },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().remaining_micros, 250_000);

    const agent = (await keyWithScopes(workspaceId,
      ['effects:begin', 'effects:report', 'effects:read'])).plaintext;
    const r = await rpc('tools/call',
      { name: 'ratchet_get_run', arguments: { run_id: run } }, agent);
    const data = r.body.result?.structuredContent;
    assert.equal(data?.budget?.limit_micros, 250_000);
    assert.equal(data?.budget?.remaining_micros, 250_000);
    // The wire is snake_case all the way down, nested objects included — this
    // is where that rule gets forgotten, and it was.
    assert.equal(JSON.stringify(data).includes('limitMicros'), false,
      'camelCase must not leak through a nested object');
  });

  test('the gate refuses the effect that would cross the ceiling', async () => {
    const run = `mcp-stop-${Date.now()}`;
    await app.inject({
      method: 'PUT', url: `/v1/runs/${run}/budget`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { limit_micros: 50_000 },
    });

    const ok = await call('ratchet_begin_effect', {
      effect_type: 'payment.charge', idempotency_key: `${run}-a`,
      run_id: run, estimated_cost_micros: 40_000,
    });
    assert.equal(ok.isError, false, 'the first spend is within the ceiling');

    const over = await call('ratchet_begin_effect', {
      effect_type: 'payment.charge', idempotency_key: `${run}-b`,
      run_id: run, estimated_cost_micros: 40_000,
    });
    assert.equal(over.isError, true, 'the second would cross it and must be refused');
  });

  test('setting a wallet is written to the audit trail', async () => {
    const run = `mcp-audit-${Date.now()}`;
    await app.inject({
      method: 'PUT', url: `/v1/runs/${run}/budget`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { limit_micros: 10_000 },
    });
    const { rows } = await (await import('../helpers.js')).getPool().query(
      "SELECT action FROM audit_events WHERE subject_id = $1 AND action = 'run.budget_set'",
      [run]);
    assert.equal(rows.length, 1, 'raising a spending limit is not a silent act');
  });
});
