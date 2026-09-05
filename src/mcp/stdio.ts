#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * MCP stdio server — for LOCAL DEVELOPMENT of this repository only.
 *
 * This talks to Postgres directly, so it requires DATABASE_URL and AUTH_SECRET.
 * It is deliberately NOT what ships to npm: an MCP server that made its users
 * hold the service's database credentials would be a far larger thing to trust
 * than the service itself.
 *
 * The published package is packages/ratchet-mcp — a thin HTTPS bridge to /mcp
 * whose only credential is the caller's own scoped, revocable API key.
 *
 * For clients that spawn a local process (Claude Desktop, Claude Code, Cursor).
 * The API key comes from RATCHET_API_KEY in the client's env block, so it never
 * appears in a command line or a config file's argument list.
 *
 * stdout carries the JSON-RPC stream and nothing else; all diagnostics go to
 * stderr, because a stray log line on stdout corrupts the protocol.
 */
import { createInterface } from 'node:readline';
import { authenticate } from '../domain/auth.js';
import { handleRpc, type JsonRpcRequest } from './protocol.js';
import { closePool } from '../db/pool.js';

const log = (msg: string) => process.stderr.write(`[ratchet-mcp] ${msg}\n`);

const apiKey = process.env.RATCHET_API_KEY;
if (!apiKey) {
  log('RATCHET_API_KEY is not set. Add it to the "env" block of your MCP client config.');
  process.exit(1);
}

let ctx;
try {
  ctx = await authenticate(apiKey);
  log(`authenticated workspace ${ctx.workspaceId} (scopes: ${ctx.scopes.join(', ')})`);
} catch (err) {
  log(`authentication failed: ${(err as Error).message}`);
  process.exit(1);
}

const send = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }
  try {
    const res = await handleRpc(msg, ctx);
    if (res) send(res);
  } catch (err) {
    log(`handler error: ${(err as Error).message}`);
    send({
      jsonrpc: '2.0', id: msg.id ?? null,
      error: { code: -32603, message: 'Internal error' },
    });
  }
}

await closePool();
