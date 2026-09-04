// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import type { FastifyInstance } from 'fastify';
import { planRateLimit } from '../api/rate-limit.js';
import { authenticate } from '../domain/auth.js';
import { authenticateOAuth } from '../domain/oauth.js';
import { config } from '../lib/config.js';
import { handleRpc, isPublicMethod, PROTOCOL_VERSION, SERVER_INFO, type JsonRpcRequest } from './protocol.js';
import { MCP_TOOLS } from './tools.js';
import { ApiError } from '../lib/errors.js';

/**
 * MCP over Streamable HTTP.
 *
 * The transport is stateless: every request carries its own API key and is
 * authorised independently, so no session state can leak between tenants and
 * the control plane stays horizontally scalable. Clients that expect a session
 * id still work — we return one derived per connection, but never rely on it
 * for authorisation.
 */
export async function registerMcpHttp(app: FastifyInstance) {
  app.post('/mcp', {
    schema: { hide: true },
    config: { rateLimit: planRateLimit },
  }, async (req, reply) => {
    const h = req.headers.authorization;
    const alt = req.headers['x-api-key'];
    const token = typeof h === 'string' && h.startsWith('Bearer ')
      ? h.slice(7)
      : (typeof alt === 'string' ? alt : null);

    // RFC 9728: point the client at the metadata that tells it where to
    // authenticate. This is the whole mechanism by which an MCP client that has
    // never seen this server can start an OAuth flow on its own.
    const base = config.publicUrl.replace(/\/+$/, '');
    const challenge = `Bearer realm="ratchet", `
      + `resource_metadata="${base}/.well-known/oauth-protected-resource"`;

    /*
     * Discovery works without a credential; acting does not.
     *
     * An MCP client connects, calls initialize and tools/list, and only then
     * asks the user for configuration. Answering those with 401 meant the
     * client reported "connection closed" and the user never learned that a key
     * was the missing piece. None of those methods reads tenant data — they
     * return the same bytes for everyone — so there is nothing to protect.
     *
     * Anything else still gets the 401 with WWW-Authenticate, because that
     * challenge is precisely how a client that has never seen this server
     * discovers where to start an OAuth flow. Losing it would break the thing
     * OAuth support exists for.
     */
    const methods = (Array.isArray(req.body) ? req.body : [req.body])
      .map((m) => (m as JsonRpcRequest | undefined)?.method);
    const allPublic = methods.length > 0 && methods.every(isPublicMethod);

    /*
     * A public method is public regardless of what the caller presents.
     *
     * The first version only skipped auth when NO token was sent. Every
     * directory and scanner passes a placeholder credential to start a server —
     * Glama's build form fills one in by default — so tools/list was still
     * answered 401, and the discovery fix did nothing for the case it was
     * written for.
     *
     * Nothing is protected by refusing here: these methods return identical
     * bytes for every caller. And for a human with a mistyped key the result is
     * better diagnostics, not worse — the tool list works, and the first
     * tools/call says plainly that the credential is bad, instead of the client
     * reporting a connection failure with no cause.
     */
    let ctx: Awaited<ReturnType<typeof authenticate>> | null = null;

    if (!allPublic) {
      if (!token) {
        reply.code(401).header('WWW-Authenticate', challenge);
        return {
          jsonrpc: '2.0', id: null,
          error: {
            code: -32001,
            message: 'Authentication required. Present a Ratchet API key, or complete the '
              + 'OAuth flow described at /.well-known/oauth-protected-resource.',
          },
        };
      }

      // An OAuth access token and an API key are both bearer credentials here.
      // Whichever it is, it resolves to the same AuthContext, so nothing
      // downstream can treat one differently from the other by accident.
      ctx = await authenticateOAuth(token, `${base}/mcp`);
      if (!ctx) {
        try {
          ctx = await authenticate(token);
        } catch (err) {
          reply.code(err instanceof ApiError ? err.status : 401);
          if (!(err instanceof ApiError) || err.status === 401) {
            reply.header('WWW-Authenticate',
              challenge.replace('Bearer realm', 'Bearer error="invalid_token", realm'));
          }
          return {
            jsonrpc: '2.0', id: null,
            error: { code: -32001, message: err instanceof ApiError ? err.message : 'Unauthorized' },
          };
        }
      }
    }

    // Only a resolved tenant gets a session id; an anonymous discovery call has
    // no workspace to name and must not be handed one.
    if (ctx) reply.header('Mcp-Session-Id', `ws_${ctx.workspaceId}`);
    reply.header('MCP-Protocol-Version', PROTOCOL_VERSION);

    const body = req.body as JsonRpcRequest | JsonRpcRequest[];

    // A batch is answered with an array; notifications drop out of it.
    if (Array.isArray(body)) {
      const out = [];
      for (const msg of body) {
        const r = await handleRpc(msg, ctx);
        if (r) out.push(r);
      }
      if (out.length === 0) { reply.code(202); return null; }
      return out;
    }

    const result = await handleRpc(body, ctx);
    if (!result) { reply.code(202); return null; }
    return result;
  });

  // Clients probe GET /mcp for a server-initiated SSE stream. Ratchet has no
  // server-initiated messages, so we decline rather than hold an idle stream.
  app.get('/mcp', { schema: { hide: true } }, async (_req, reply) => {
    reply.code(405).header('Allow', 'POST');
    return {
      jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'This server does not open server-initiated streams. Use POST.' },
    };
  });

  app.delete('/mcp', { schema: { hide: true } }, async (_req, reply) => {
    // Stateless: nothing to tear down.
    reply.code(204);
    return null;
  });

  /** Human- and agent-readable description of the MCP surface. */
  app.get('/mcp/info', {
    schema: {
      tags: ['Meta'], operationId: 'mcpInfo',
      summary: 'MCP server metadata and tool list',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => ({
    server: SERVER_INFO,
    protocol_version: PROTOCOL_VERSION,
    transport: 'streamable-http',
    endpoint: '/mcp',
    authentication: 'Authorization: Bearer <ratchet_api_key>',
    tools: MCP_TOOLS.map((t) => ({
      name: t.name, title: t.title, description: t.description,
      input_schema: t.inputSchema, required_scope: t.scope, read_only: t.readOnly,
    })),
  }));
}
