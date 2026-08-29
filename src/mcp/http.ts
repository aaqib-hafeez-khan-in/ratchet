import type { FastifyInstance } from 'fastify';
import { authenticate } from '../domain/auth.js';
import { handleRpc, PROTOCOL_VERSION, SERVER_INFO, type JsonRpcRequest } from './protocol.js';
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
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const h = req.headers.authorization;
    const alt = req.headers['x-api-key'];
    const token = typeof h === 'string' && h.startsWith('Bearer ')
      ? h.slice(7)
      : (typeof alt === 'string' ? alt : null);

    if (!token) {
      // Per the MCP HTTP auth spec, advertise how to authenticate.
      reply.code(401).header('WWW-Authenticate',
        'Bearer realm="ratchet", error="invalid_token"');
      return {
        jsonrpc: '2.0', id: null,
        error: {
          code: -32001,
          message: 'Missing API key. Send "Authorization: Bearer <ratchet_api_key>".',
        },
      };
    }

    let ctx;
    try {
      ctx = await authenticate(token);
    } catch (err) {
      reply.code(err instanceof ApiError ? err.status : 401);
      return {
        jsonrpc: '2.0', id: null,
        error: { code: -32001, message: err instanceof ApiError ? err.message : 'Unauthorized' },
      };
    }

    reply.header('Mcp-Session-Id', `ws_${ctx.workspaceId}`);
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
