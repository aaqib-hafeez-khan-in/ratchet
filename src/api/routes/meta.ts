import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { config } from '../../lib/config.js';
import { PLANS } from '../../domain/plans.js';
import { SCOPES } from '../../domain/auth.js';
import { EVENT_TYPES } from '../../domain/events.js';
import { MCP_TOOLS } from '../../mcp/tools.js';

const startedAt = Date.now();

export default async function metaRoutes(app: FastifyInstance) {
  app.get('/healthz', {
    schema: { tags: ['Meta'], operationId: 'healthz', summary: 'Liveness probe',
      response: { 200: { type: 'object', additionalProperties: true } } },
  }, async () => ({ status: 'ok', uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }));

  app.get('/readyz', {
    schema: { tags: ['Meta'], operationId: 'readyz', summary: 'Readiness probe (checks the database)',
      response: { 200: { type: 'object', additionalProperties: true },
                  503: { type: 'object', additionalProperties: true } } },
  }, async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    try {
      await getPool().query('SELECT 1');
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { status: 'ready', database: { ok: true, latency_ms: Number(ms.toFixed(2)) } };
    } catch {
      reply.code(503);
      return { status: 'not_ready', database: { ok: false } };
    }
  });

  /**
   * Machine-readable capability manifest. Deliberately states what the service
   * does NOT do, so an agent can rule it out quickly instead of discovering
   * the boundary through a failed call.
   */
  app.get('/.well-known/agent-manifest.json', {
    schema: { tags: ['Meta'], operationId: 'agentManifest',
      summary: 'Capability manifest for agent discovery',
      response: { 200: { type: 'object', additionalProperties: true } } },
  }, async () => ({
    schema_version: '1',
    name: 'Ratchet',
    description:
      'An effect gate for AI agents. Before an agent performs a side effect it asks Ratchet ' +
      'for permission; Ratchet returns a durable decision — execute, replay a recorded result, ' +
      'wait, or stop — so the same real-world action is attempted at most once, stays inside a ' +
      'declared budget, and leaves an auditable record.',
    version: '0.1.0',
    documentation_url: `${config.publicUrl}/docs`,
    openapi_url: `${config.publicUrl}/openapi.json`,
    llms_txt_url: `${config.publicUrl}/llms.txt`,
    api_base_url: `${config.publicUrl}/v1`,
    authentication: {
      type: 'bearer',
      header: 'Authorization: Bearer <api_key>',
      alternate_header: 'X-API-Key',
      obtain: `POST ${config.publicUrl}/v1/workspaces`,
      scopes: SCOPES,
    },
    mcp: {
      protocol: 'model-context-protocol',
      transports: {
        stdio: { command: 'npx', args: ['-y', 'ratchet-mcp'], note: 'Not yet published to npm; run from source with `npm run mcp:stdio`.' },
        streamable_http: { url: `${config.publicUrl}/mcp` },
      },
      tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    },
    core_workflow: [
      'POST /v1/effects/begin with an effect_type and a deterministic idempotency_key',
      'Branch on `decision`: execute | duplicate | in_flight | blocked | approval_required | denied',
      'If execute — perform the real side effect, then POST /v1/effects/{id}/report with the lease_token',
      'If duplicate — replay the returned `result`; do not perform the action again',
      'If blocked — a prior attempt is indeterminate; verify reality, then POST /v1/effects/{id}/resolve',
    ],
    capabilities: [
      'at-most-once gating of side effects across processes, machines, and model providers',
      'durable recorded results replayed to duplicate callers',
      'leases with fencing tokens so a stalled worker cannot overwrite a newer attempt',
      'explicit indeterminate state when an attempt neither completes nor cleanly fails',
      'per-effect, per-key, and per-type daily external spend ceilings',
      'operator approval gating for named effect types',
      'signed webhooks with SSRF protection',
      'immutable credit ledger and audit trail',
    ],
    does_not: [
      'execute code, shell commands, or HTTP requests on the caller\'s behalf',
      'store the raw payload of a gated effect (only a fingerprint is kept)',
      'guarantee exactly-once delivery — that is not achievable; Ratchet guarantees at-most-once initiation and makes the unknown case explicit',
      'hold customer funds or act as a payment processor for third-party effects',
      'proxy, transform, or inspect the side effect itself',
    ],
    events: EVENT_TYPES,
    pricing: {
      meter: 'gated_effect',
      free_tier_effects_per_month: PLANS.free.includedEffects,
      plans_url: `${config.publicUrl}/v1/billing/plans`,
    },
    limits: {
      max_request_bytes: config.maxRequestBytes,
      max_result_bytes: config.maxResultBytes,
      rate_limit_per_minute_by_plan: Object.fromEntries(
        Object.values(PLANS).map((p) => [p.id, p.rateLimitPerMinute])),
    },
  }));

  app.get('/llms.txt', {
    schema: {
      tags: ['Meta'], operationId: 'llmsTxt',
      summary: 'Concise machine-oriented documentation index',
      response: { 200: { type: 'string' } },
    },
  }, async (_req, reply) => {
    reply.type('text/plain; charset=utf-8');
    return `# Ratchet

> An effect gate for AI agents. Ask before you act; Ratchet answers durably so the
> same real-world side effect is attempted at most once, stays inside a declared
> budget, and leaves an auditable record.

## The problem
Agents retry. LLM control flow is non-deterministic, network calls fail ambiguously,
and processes crash mid-action. The result is duplicate emails, double charges, and
repeated writes. Vendor-side idempotency keys only help for the few vendors that
offer them, and never across separate agent processes or model providers.

## The core loop
1. POST ${config.publicUrl}/v1/effects/begin
   { "effect_type": "email.send", "idempotency_key": "welcome:user_123", "payload": {...} }
2. Branch on the returned "decision":
   - execute            -> you hold the lease. Do the action, then report.
   - duplicate          -> already done. Replay "result". Do NOT act.
   - in_flight          -> another caller holds a live lease. Back off.
   - blocked            -> a prior attempt's outcome is unknown. Verify, then resolve.
   - approval_required  -> an operator must approve first.
   - denied             -> policy or budget refused it.
3. POST ${config.publicUrl}/v1/effects/{effect_id}/report
   { "lease_token": "...", "outcome": "succeeded", "result": {...} }

## The important part
If your process dies between step 2 and step 3, Ratchet does NOT silently let the
next caller retry. The lease expires and the effect becomes "indeterminate" — a
known unknown. Your configured policy for that effect type decides what happens:
block (default), retry (only for vendors that are genuinely idempotent), or probe
(a caller must verify reality first). Duplicates stop being invisible.

## Endpoints
- POST   /v1/workspaces                    create a workspace + first API key
- POST   /v1/effects/begin                 the gate (this is the metered call)
- POST   /v1/effects/{id}/report           close out a leased effect
- POST   /v1/effects/{id}/resolve          settle an indeterminate effect
- POST   /v1/effects/{id}/cancel           cancel an effect that has not run
- GET    /v1/effects/lookup                find by effect_type + idempotency_key (free)
- GET    /v1/effects                       list recent effects
- GET/PUT /v1/policies/{effect_type}       per-effect-type policy
- GET    /v1/workspace                     plan, credit balance, usage
- GET    /v1/billing/plans                 pricing

## Authentication
Authorization: Bearer rk_test_<prefix>_<secret>   (or X-API-Key)
Keys are scoped. An executing agent needs only effects:begin and effects:report.

## Idempotency keys
Derive the key from the work itself, never from a random value or a timestamp.
Good:  "invoice:2026-08:acct_88123"   "welcome-email:user_123"
Bad:   uuid4()                        "send-" + Date.now()

## MCP
Streamable HTTP: ${config.publicUrl}/mcp
Tools: ${MCP_TOOLS.map((t) => t.name).join(', ')}

## Pricing
Meter: one "gated effect" = the first begin() for an (effect_type, idempotency_key).
Duplicate suppression, retries, reports, and reads are free.
Free plan: ${PLANS.free.includedEffects.toLocaleString()} gated effects per month.

## More
- OpenAPI:  ${config.publicUrl}/openapi.json
- Manifest: ${config.publicUrl}/.well-known/agent-manifest.json
- Docs:     ${config.publicUrl}/docs
`;
  });
}
