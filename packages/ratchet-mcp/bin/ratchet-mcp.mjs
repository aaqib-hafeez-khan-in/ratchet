#!/usr/bin/env node
/**
 * Ratchet MCP server (stdio transport).
 *
 * A thin bridge: it reads line-delimited JSON-RPC on stdin, forwards each
 * message to a Ratchet instance's /mcp endpoint over HTTPS, and writes the
 * reply to stdout.
 *
 * Deliberately holds no database connection and no server secret. The only
 * credential is the caller's own API key, which is scoped and revocable. An
 * MCP server that required its users to hold the service's database
 * credentials would be a much larger thing to trust than the service itself.
 *
 * Zero dependencies — Node built-ins only.
 *
 *   RATCHET_API_KEY=rk_live_... npx ratchet-mcp
 */
import { createInterface } from 'node:readline';

const BASE = (process.env.RATCHET_BASE_URL ?? 'https://ratchetgate.com').replace(/\/+$/, '');
const KEY = process.env.RATCHET_API_KEY;
const TIMEOUT_MS = Number.parseInt(process.env.RATCHET_TIMEOUT_MS ?? '15000', 10);

// stdout carries the protocol and nothing else; a stray log line there
// corrupts the stream and the client fails in confusing ways.
const log = (m) => process.stderr.write(`[ratchet-mcp] ${m}\n`);
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (!KEY) {
  log('RATCHET_API_KEY is not set.');
  log('Add it to the "env" block of your MCP client config — not "args", which');
  log('is visible in process listings. Get a key at ' + BASE + '/console');
  process.exit(1);
}

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0', id: id ?? null,
  error: { code, message, ...(data ? { data } : {}) },
});

async function forward(msg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(msg),
      signal: controller.signal,
    });

    // A notification is answered with 202 and no body, by design.
    if (res.status === 202) return null;

    const text = await res.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return rpcError(msg.id, -32603, `Ratchet returned a non-JSON response (HTTP ${res.status})`);
    }
  } catch (err) {
    // Surface transport failures as JSON-RPC errors rather than dying: the
    // client can then tell its model the gate is unreachable, which is a
    // decision it needs to make rather than a crash it cannot see.
    const aborted = err?.name === 'AbortError';
    return rpcError(msg.id, -32001,
      aborted ? `Ratchet did not respond within ${TIMEOUT_MS}ms` : `Cannot reach Ratchet at ${BASE}`,
      { hint: 'If your agent cannot reach the gate, apply your configured fail-open or '
            + 'fail-closed policy. See ' + BASE + '/docs' });
  } finally {
    clearTimeout(timer);
  }
}

log(`bridging stdio → ${BASE}/mcp`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send(rpcError(null, -32700, 'Parse error'));
    continue;
  }

  try {
    const reply = await forward(msg);
    if (reply) send(reply);
  } catch (err) {
    log(`unexpected: ${err?.message ?? err}`);
    send(rpcError(msg?.id, -32603, 'Internal error in the stdio bridge'));
  }
}
