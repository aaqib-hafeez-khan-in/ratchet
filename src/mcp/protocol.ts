// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Minimal, spec-faithful MCP JSON-RPC handling shared by both transports.
 * Kept dependency-free so the same code path serves the HTTP endpoint inside
 * Fastify and the stdio process, with no divergence between them.
 */
import { createRequire } from 'node:module';
import { MCP_TOOLS } from './tools.js';
import { callTool, toolError } from './handlers.js';
import type { AuthContext } from '../domain/auth.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Read from package.json rather than typed here.
 *
 * There were five places declaring a version and four different answers: the
 * repository said 0.1.0, the bridge package 0.2.0, the registry manifest 0.2.0
 * for the server and 0.1.1 for its package, and npm had published 0.1.1. A
 * client asking `initialize` was told 0.1.0 while the registry advertised
 * 0.2.0 — which is the kind of inconsistency that makes a directory distrust a
 * listing, and rightly.
 */
const PKG = createRequire(import.meta.url)('../../package.json') as { version: string };

export const SERVER_INFO = {
  name: 'ratchet',
  title: 'Ratchet — effect gate',
  version: PKG.version,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: string | number | null, result: unknown): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, result });

const fail = (id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

export const INSTRUCTIONS =
  'Ratchet gates side effects so the same real-world action is attempted at most once.\n\n' +
  'Before ANY action that touches the outside world — sending a message, charging a card, ' +
  'creating or modifying a resource in someone else\'s system — call ratchet_begin_effect and ' +
  'obey the decision it returns. Only "execute" authorises you to act. "duplicate", "in_flight", ' +
  '"blocked", "approval_required", and "denied" all mean: do not perform the action.\n\n' +
  'After acting, call ratchet_report_effect. If you are genuinely unsure whether the action ' +
  'reached the outside world, report nothing — an unreported lease is recorded as "indeterminate", ' +
  'which is safer than a wrong answer.\n\n' +
  'Derive idempotency keys deterministically from the work itself, never from a random value or ' +
  'the current time, or the gate cannot recognise a retry.';

/**
 * Handle one JSON-RPC message. Returns null for notifications, which by spec
 * receive no response.
 */
/**
 * Methods that carry no tenant data and therefore need no credential.
 *
 * Every one of these returns the same bytes for every caller: the protocol
 * version, the server name, and the tool definitions — which live in a public
 * repository and are described on the website. Requiring a key to read them
 * protected nothing and cost a great deal, because an MCP client lists tools
 * BEFORE the user has configured credentials. A server that refuses is reported
 * to that user as "connection closed", with no hint that a key was all it
 * wanted.
 *
 * `tools/call` is not here, and must not be: that is where a credential starts
 * mattering, and where the 401 challenge that bootstraps OAuth is issued.
 */
export const PUBLIC_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'ping',
  'tools/list',
]);

export const isPublicMethod = (m: unknown): boolean =>
  typeof m === 'string' && PUBLIC_METHODS.has(m);

export async function handleRpc(
  msg: JsonRpcRequest, ctx: AuthContext | null,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(id, -32600, 'Invalid Request');
  }

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested : PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            title: t.title,
            readOnlyHint: t.readOnly,
            destructiveHint: false,
            idempotentHint: t.readOnly,
            openWorldHint: false,
          },
        })),
      });

    case 'tools/call': {
      // Belt and braces. The HTTP layer answers an unauthenticated tools/call
      // with 401 so the client can discover OAuth; this makes it impossible for
      // any other caller of handleRpc to reach a tool without a context.
      if (!ctx) {
        return fail(id, -32001,
          'Authentication required for tools/call. Set RATCHET_API_KEY, or complete '
          + 'the OAuth flow at /.well-known/oauth-protected-resource.');
      }
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== 'string') return fail(id, -32602, 'Missing tool name');
      try {
        const result = await callTool(ctx, name, args);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        });
      } catch (err) {
        // A tool-level failure is reported inside the result, not as a
        // protocol error, so the model can read and act on it.
        const e = toolError(err);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: e }, null, 2) }],
          structuredContent: { error: e },
          isError: true,
        });
      }
    }

    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });

    default:
      return fail(id, -32601, `Method not found: ${msg.method}`);
  }
}
