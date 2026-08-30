import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import { authenticate, cachedPlanLimit } from '../domain/auth.js';
import { PLANS } from '../domain/plans.js';
import authPlugin from './plugins/auth.js';
import effectRoutes from './routes/effects.js';
import groupRoutes from './routes/groups.js';
import workspaceRoutes from './routes/workspace.js';
import billingRoutes from './routes/billing.js';
import metaRoutes from './routes/meta.js';
import { registerMcpHttp } from '../mcp/http.js';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/** The public, non-secret prefix of whichever API key a request presents. */
function keyPrefixOf(req: { headers: Record<string, unknown> }): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer rk_')) {
    const m = /^Bearer rk_(?:live|test)_([a-z0-9]{12})_/.exec(h);
    if (m) return m[1]!;
  }
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string') {
    const m = /^rk_(?:live|test)_([a-z0-9]{12})_/.exec(alt);
    if (m) return m[1]!;
  }
  return null;
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never let a secret reach the logs, even at debug level.
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers["x-api-key"]',
          'req.headers.cookie', 'req.headers["stripe-signature"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (r) => ({ method: r.method, url: r.url, id: r.id }),
      },
    },
    bodyLimit: config.maxRequestBytes,
    trustProxy: true,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
    ajv: {
      customOptions: {
        // Fastify strips unknown properties by default. For an agent-facing
        // API that silently swallows mistakes: a caller who writes
        // `estimated_cost` instead of `estimated_cost_micros` would lose budget
        // enforcement and never be told. Reject instead, so the typo surfaces
        // on the first call rather than as a surprise invoice.
        removeAdditional: false,
      },
    },
  });

  // Capture the raw body for signature-verified webhook routes only. Verifying
  // an HMAC against a re-serialized body is unsound, so we keep the bytes.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (!req.routeOptions?.config || !(req.routeOptions.config as { rawBody?: boolean }).rawBody) {
      return payload;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    (req as unknown as { rawBody: string }).rawBody = raw.toString('utf8');
    const { Readable } = await import('node:stream');
    return Readable.from([raw]);
  });

  // -------------------------------------------------------------- security
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (config.isProd) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // API responses are per-key and must never be cached by a shared proxy.
    if (req.url.startsWith('/v1')) reply.header('Cache-Control', 'no-store');
    if (String(reply.getHeader('content-type') ?? '').includes('text/html')) {
      reply.header('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    }
    return payload;
  });

  await app.register(cookie, { secret: config.authSecret, parseOptions: {} });

  await app.register(cors, {
    // Same-origin only unless origins are explicitly configured. Credentials
    // are never granted to a wildcard origin.
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: config.corsOrigins.length > 0,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
    exposedHeaders: ['Mcp-Session-Id'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    // Per-plan, not a single global number. Publishing a per-plan limit in the
    // pricing table while enforcing one shared value would mean selling an
    // entitlement the code does not deliver.
    max: (req) => {
      if (config.rateLimitOverride !== null) return config.rateLimitOverride;
      const prefix = keyPrefixOf(req);
      if (!prefix) return config.rateLimitPerMinute;      // unauthenticated
      return cachedPlanLimit(prefix) ?? PLANS.free.rateLimitPerMinute;
    },
    timeWindow: '1 minute',
    // Limit per API key where one is presented, so one tenant cannot exhaust
    // another's budget from behind a shared NAT.
    keyGenerator: (req) => {
      const prefix = keyPrefixOf(req);
      return prefix ? `key:${prefix}` : `ip:${req.ip}`;
    },
    // The builder's return value is handed to the error handler as the error
    // itself, so it must be a real ApiError. A plain object arrives with no
    // status and degrades a 429 into a 500.
    errorResponseBuilder: (_req, ctx) => new ApiError(
      429, 'rate_limited',
      `Rate limit exceeded. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
      { limit: ctx.max, retry_after_seconds: Math.ceil(ctx.ttl / 1000) },
    ),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Ratchet API',
        version: '0.1.0',
        description:
          'An effect gate for AI agents. Ask before you act; Ratchet answers durably so the same ' +
          'real-world side effect is attempted at most once, stays inside a declared budget, and ' +
          'leaves an auditable record.',
        license: { name: 'Apache-2.0' },
      },
      // The server is the origin, and every path is emitted in full below.
      // Setting the server to `${publicUrl}/v1` would make @fastify/swagger
      // strip that prefix from every path — which is right for /v1 routes and
      // silently wrong for the root-level ones (/healthz, /llms.txt, /mcp),
      // pointing clients at URLs that do not exist.
      servers: [{ url: config.publicUrl, description: 'This instance' }],
      tags: [
        { name: 'Effects', description: 'The gate: begin, report, resolve.' },
        { name: 'Groups', description: 'Units of work that can be rolled back as a whole.' },
        { name: 'Policies', description: 'Per-effect-type rules for retries, budgets, and approval.' },
        { name: 'Workspace', description: 'Keys, usage, ledger, audit.' },
        { name: 'Webhooks', description: 'Signed event delivery.' },
        { name: 'Billing', description: 'Plans and prepaid credit.' },
        { name: 'Meta', description: 'Health, manifest, discovery.' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer',
            description: 'A scoped Ratchet API key: rk_<env>_<prefix>_<secret>' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    stripBasePath: false,
  });

  await app.register(authPlugin);

  // ------------------------------------------------------------- error shape
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status);
      return reply.send({
        error: { code: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) },
      });
    }
    if ((err as { validation?: unknown }).validation) {
      reply.code(400);
      return reply.send({
        error: {
          code: 'invalid_request',
          message: (err as Error).message,
          detail: { validation: (err as { validation: unknown }).validation },
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      reply.code(500);
      // Internal detail is deliberately not returned to the caller.
      return reply.send({
        error: { code: 'internal_error', message: 'Internal error.', detail: { request_id: req.id } },
      });
    }
    reply.code(status);
    return reply.send({ error: { code: 'request_error', message: (err as Error).message } });
  });

  app.setNotFoundHandler({
    preHandler: app.rateLimit(),
  }, (req, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` },
    });
  });

  // ---------------------------------------------------------------- routes
  await app.register(async (v1) => {
    // Per-plan rate limiting layered on top of the global default.
    v1.addHook('onRequest', async (req) => {
      const h = req.headers.authorization;
      if (typeof h === 'string' && h.startsWith('Bearer rk_')) {
        try { req.auth = await authenticate(h.slice(7)); } catch { /* handled by route guard */ }
      }
    });
    await v1.register(effectRoutes);
    await v1.register(groupRoutes);
    await v1.register(workspaceRoutes);
    await v1.register(billingRoutes);
  }, { prefix: '/v1' });

  await app.register(metaRoutes);
  await registerMcpHttp(app);

  // OpenAPI document, served from the same schemas the routes validate against.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // ------------------------------------------------------------------- web
  await app.register(fastifyStatic, { root: webRoot, prefix: '/', index: ['index.html'] });
  // HTML pages are hidden from the OpenAPI document: it describes the API an
  // agent calls, not the site a human reads.
  for (const page of ['docs', 'console', 'pricing', 'security']) {
    app.get(`/${page}`, { schema: { hide: true } },
      async (_req, reply) => reply.sendFile(`${page}.html`));
  }

  return app;
}
