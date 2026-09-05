// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { handleRpc, type JsonRpcRequest, type JsonRpcResponse } from '../../src/mcp/protocol.js';
import type { AuthContext } from '../../src/domain/auth.js';

type Response = JsonRpcResponse;

const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);
const AUTH_CONTEXT = {} as AuthContext;

const ids = fc.oneof(fc.string(), fc.integer(), fc.constant(null));
const methods = fc.string({ minLength: 1, maxLength: 200 });
const params = fc.dictionary(fc.string({ minLength: 1, maxLength: 40 }), fc.jsonValue());
const malformedParams = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.jsonValue(), { maxLength: 3 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 40 }), fc.jsonValue())
    .filter((value) => !Object.hasOwn(value, 'name')),
);

const request = fc.record({
  id: ids,
  method: methods,
  params: fc.option(params, { nil: undefined }),
}).map(({ id, method, params }): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
}));

const isResponse = (value: Response | null): value is Response => value !== null;

describe('MCP JSON-RPC parser fuzzing', () => {
  test('never throws for attacker-controlled requests', async () => {
    await fc.assert(fc.asyncProperty(request, async (msg) => {
      const out = await handleRpc(msg, null);
      assert.ok(out === null || typeof out === 'object');
    }), { numRuns: RUNS });
  });

  test('responses are valid JSON-RPC with the request id and exactly one payload member', async () => {
    await fc.assert(fc.asyncProperty(request, async (msg) => {
      const out = await handleRpc(msg, null);
      if (!isResponse(out)) return;

      assert.equal(out.jsonrpc, '2.0');
      assert.deepEqual(out.id, msg.id ?? null);
      assert.equal(Number('result' in out) + Number('error' in out), 1);
      assert.equal(JSON.parse(JSON.stringify(out)).jsonrpc, '2.0');
    }), { numRuns: RUNS });
  });

  test('unknown methods always return JSON-RPC method-not-found', async () => {
    await fc.assert(fc.asyncProperty(ids, methods.filter((method) => ![
      'initialize',
      'notifications/initialized',
      'notifications/cancelled',
      'ping',
      'tools/list',
      'tools/call',
      'resources/list',
      'prompts/list',
    ].includes(method)), async (id, method) => {
      const out = await handleRpc({ jsonrpc: '2.0', id, method }, null);
      assert.ok(out !== null);
      assert.equal(out.error?.code, -32601);
      assert.equal('result' in out, false);
    }), { numRuns: RUNS });
  });

  test('malformed tools/call parameters always return invalid-params', async () => {
    await fc.assert(fc.asyncProperty(ids, malformedParams, async (id, params) => {
      const out = await handleRpc({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: params as Record<string, any>,
      }, AUTH_CONTEXT);
      assert.ok(out !== null);
      assert.equal(out.error?.code, -32602);
      assert.equal('result' in out, false);
    }), { numRuns: RUNS });
  });

  test('responses never put the original request object in result position', async () => {
    await fc.assert(fc.asyncProperty(request, async (msg) => {
      const out = await handleRpc(msg, null);
      if (!isResponse(out) || !('result' in out)) return;
      assert.notDeepEqual(out.result, msg);
    }), { numRuns: RUNS });
  });
});