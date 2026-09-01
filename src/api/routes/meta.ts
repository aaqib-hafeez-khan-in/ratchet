import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import { config } from '../../lib/config.js';
import { PLANS } from '../../domain/plans.js';
import { SCOPES } from '../../domain/auth.js';
import { EVENT_TYPES } from '../../domain/events.js';
import { MCP_TOOLS } from '../../mcp/tools.js';
import { recipes } from '../../domain/integrate.js';
import { VENDOR_PROFILES, type VendorProfile } from '../../domain/vendor-keys.js';
import { workerHealth } from '../../worker/heartbeat.js';

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
   * Is the worker actually working?
   *
   * A SEPARATE endpoint from /readyz on purpose. /readyz is what the platform
   * uses to decide whether this API machine should receive traffic, and a
   * stalled worker must never take the control plane offline — the gate still
   * works perfectly without it, it just stops expiring leases.
   *
   * This one returns 503 when a worker loop has stopped finishing, so an
   * external uptime monitor can alert on it. That matters more than it sounds:
   * if the worker dies, leases never expire, effects stay `pending` for ever,
   * and every retry is answered `in_flight` — indefinitely, with no error
   * anywhere. A worker that has never checked in at all reports separately from
   * one that has stalled, because "never deployed" and "stopped" need different
   * fixes.
   *
   * Unauthenticated, because a monitor should not need a credential, and
   * deliberately terse: loop names and staleness, no instance identifiers.
   */
  app.get('/workerz', {
    schema: {
      tags: ['Meta'], operationId: 'workerz',
      summary: 'Worker liveness probe (point an uptime monitor at this)',
      response: { 200: { type: 'object', additionalProperties: true },
                  503: { type: 'object', additionalProperties: true } },
    },
  }, async (_req, reply) => {
    try {
      const h = await workerHealth();
      if (!h.everStarted) {
        reply.code(503);
        return { status: 'never_started',
          detail: 'No worker has ever checked in. Leases will never expire.' };
      }
      const stale = h.loops.filter((l) => l.stale).map((l) => l.loop);
      if (stale.length > 0) {
        reply.code(503);
        return { status: 'stalled', stalled_loops: stale,
          detail: 'A worker loop has stopped completing. Leases may not be expiring.' };
      }
      return { status: 'ok', loops: h.loops.length };
    } catch {
      reply.code(503);
      return { status: 'unknown', detail: 'Could not read worker heartbeats.' };
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
    // Runnable integration code, per runtime. An agent that finds this
    // manifest can integrate itself without waiting for a person.
    integrate_url: `${config.publicUrl}/v1/integrate`,
    // How a client with no API key obtains access on its own. Connector
    // directories read this to decide whether the server can be listed.
    oauth: {
      protected_resource_metadata: `${config.publicUrl}/.well-known/oauth-protected-resource`,
      authorization_server_metadata: `${config.publicUrl}/.well-known/oauth-authorization-server`,
      dynamic_client_registration: true,
      pkce_required: true,
      code_challenge_methods: ['S256'],
      grant_types: ['authorization_code', 'refresh_token'],
    },
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
      'surge containment: a circuit breaker per effect type that opens when an agent '
        + 'starts performing one far more often than its configured hourly ceiling, and a '
        + 'workspace-wide emergency stop. An open breaker raises the effect type to '
        + 'require_approval by default, so work waits for a human rather than the agent '
        + 'being killed',
      'operator approval gating for named effect types',
      'signed webhooks with SSRF protection',
      'immutable credit ledger and audit trail',
      'worker liveness at GET /workerz, which returns 503 when lease expiry has stopped '
        + 'running — the failure that would otherwise leave effects pending for ever',
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

  /**
   * Self-service integration for non-human callers.
   *
   * Public and unauthenticated on purpose: an agent that has just discovered
   * this service does not have a key yet, and requiring one to learn how to
   * integrate would put a human in the middle of the only step that does not
   * need one. Nothing here is per-workspace, so there is nothing to leak.
   */
  app.get('/v1/integrate', {
    schema: {
      tags: ['Meta'], operationId: 'integrate',
      summary: 'Runnable integration code for a given runtime',
      description:
        'Returns working code for the caller\'s own runtime. Omit "runtime" to list what is '
        + 'available. Send Accept: text/plain to get just the code, ready to pipe to a file.',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { runtime: { type: 'string', maxLength: 32 } },
      },
      response: { 200: { type: 'object', additionalProperties: true },
                  404: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const base = config.publicUrl.replace(/\/+$/, '');
    const all = recipes(base);
    const wanted = (req.query as { runtime?: string }).runtime;
    const wantsText = String(req.headers.accept ?? '').includes('text/plain');

    if (!wanted) {
      const index = {
        service: 'ratchet',
        summary: 'An effect gate. Ask before you act; the same real-world action happens at most once.',
        usage: `GET ${base}/v1/integrate?runtime=<name>`,
        runtimes: all.map((r) => ({ runtime: r.runtime, title: r.title, language: r.language })),
        also: { manifest: `${base}/.well-known/agent-manifest.json`,
                openapi: `${base}/openapi.json`,
        integrate: `${base}/v1/integrate`, guide: `${base}/llms.txt`,
                mcp: `${base}/mcp` },
      };
      if (wantsText) {
        return reply.type('text/plain; charset=utf-8').send(
          [`# ${index.summary}`, '', `# ${index.usage}`, '',
           ...all.map((r) => `${r.runtime.padEnd(10)} ${r.title}`), ''].join('\n'));
      }
      return index;
    }

    const hit = all.find((r) => r.runtime === wanted.toLowerCase());
    if (!hit) {
      reply.code(404);
      const known = all.map((r) => r.runtime);
      if (wantsText) {
        return reply.type('text/plain; charset=utf-8').send(
          `# unknown runtime "${wanted}". Known: ${known.join(', ')}\n`
          + `# Anything that can make an HTTPS POST works — try: ?runtime=http\n`);
      }
      return { error: { code: 'unknown_runtime',
        message: `No recipe for "${wanted}". Anything that can make an HTTPS POST works; `
          + 'use runtime=http for the raw calls.',
        detail: { known_runtimes: known } } };
    }

    if (wantsText) {
      return reply.type('text/plain; charset=utf-8').send(
        `# ${hit.title}\n# ${hit.filename}\n`
        + (hit.install ? `# install: ${hit.install}\n` : '')
        + `\n${hit.code}\n\n`
        + hit.notes.map((n) => `# NOTE: ${n}`).join('\n') + '\n');
    }
    return { ...hit, next: { create_key: `${base}/console`, docs: `${base}/docs` } };
  });

  /**
   * RFC 9116. A service selling a security property needs somewhere to receive
   * a report; the Expires field is generated six months out on every request so
   * the document can never go stale and read as abandoned.
   */
  app.get('/.well-known/security.txt', { schema: { hide: true } }, async (_req, reply) => {
    const base = config.publicUrl.replace(/\/+$/, '');
    const host = new URL(base).hostname.replace(/^www\./, '');
    const expires = new Date(Date.now() + 180 * 86_400_000).toISOString();
    return reply.type('text/plain; charset=utf-8').send(
      [`Contact: mailto:security@${host}`,
       `Expires: ${expires}`,
       'Preferred-Languages: en',
       `Canonical: ${base}/.well-known/security.txt`,
       `Policy: ${base}/security`,
       '',
       '# Ratchet never performs the side effects it gates, holds no vendor',
       '# credentials, and stores only a fingerprint of any gated payload.',
       '# Reports about those boundaries are especially welcome.',
       ''].join('\n'));
  });

  /**
   * Domain-ownership proof for the official MCP registry, which grants the
   * com.ratchetgate.* namespace. The public half of an Ed25519 pair; the
   * private half never leaves the operator's machine.
   */
  app.get('/.well-known/mcp-registry-auth', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/plain; charset=utf-8')
      .send('v=MCPv1; k=ed25519; p=wYouDJAI29Et6BJBfWsDww0CWkyY2iV1eHNX7vokzVw=\n'));

  /**
   * Free, keyless reference: does this vendor deduplicate, and how?
   *
   * Deliberately requires no account. Every product in this category gates its
   * usefulness behind a signup, and every one of them has no users; the
   * services agents actually adopt answer on the first call. This answers a
   * question any agent about to charge a card genuinely needs answered, and
   * costs us nothing to give away.
   *
   * It is also honest where it hurts: vendors that do NOT deduplicate are
   * listed as not deduplicating, including ones we would rather claim.
   */
  /**
   * The wire is snake_case; the domain is camelCase. Spreading the profile
   * straight into the response published `maxLength`, which is the one rule in
   * the conventions that has no exceptions. Fixed while the endpoint is young
   * enough that almost nobody consumes it.
   */
  const onWire = (v: VendorProfile) => ({
    vendor: v.vendor,
    placement: v.placement,
    max_length: v.maxLength,
    retention: v.retention,
    enforced: v.enforced,
    note: v.note,
  });

  app.get('/v1/vendors', {
    schema: {
      tags: ['Meta'], operationId: 'listVendors',
      summary: 'Which vendors enforce idempotency, and how (free, no key)',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const base = config.publicUrl.replace(/\/+$/, '');
    const rows = Object.values(VENDOR_PROFILES).filter((v) => v.vendor !== 'generic');
    if (String(req.headers.accept ?? '').includes('text/plain')) {
      return reply.type('text/plain; charset=utf-8').send(
        ['# Does this vendor deduplicate a repeated request?', '',
         ...rows.map((v) => `${v.vendor.padEnd(10)} ${v.enforced ? 'YES' : 'no '}  `
           + `${v.placement} (max ${v.maxLength}, kept ${v.retention})`),
         '', `# ${base}/v1/vendors/<name> for one vendor.`, ''].join('\n'));
    }
    return {
      summary: 'Whether each vendor refuses a repeated request, and where its key goes.',
      note: 'An idempotency key only helps where the vendor honours it. Where "enforced" is '
        + 'false, retrying really can perform the action twice, whatever your code does.',
      vendors: rows.map(onWire),
      detail: `${base}/v1/vendors/{vendor}`,
    };
  });

  app.get('/v1/vendors/:vendor', {
    schema: {
      tags: ['Meta'], operationId: 'getVendor',
      summary: 'Idempotency behaviour for one vendor (free, no key)',
      response: { 200: { type: 'object', additionalProperties: true },
                  404: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const name = String((req.params as { vendor: string }).vendor).toLowerCase();
    const v = VENDOR_PROFILES[name];
    if (!v) {
      reply.code(404);
      return { error: { code: 'unknown_vendor',
        message: `No profile for "${name}".`,
        detail: { known: Object.keys(VENDOR_PROFILES) } } };
    }
    return {
      ...onWire(v),
      how_to_get_a_key: `${config.publicUrl.replace(/\/+$/, '')}/v1/integrate?runtime=http`,
    };
  });

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

## Do not rely on being asked
A gate only stops the agents that call it. When Ratchet answers "execute" it also
returns vendor_idempotency_key: the key the VENDOR deduplicates on. Send it to
Stripe, Square, Adyen, PayPal — and the vendor refuses the duplicate itself, even
if some other process never calls Ratchet at all.
  "vendor_idempotency_key": { "key": "rtk_...", "placement": "Idempotency-Key header",
                              "enforced": true }
When "enforced" is false the vendor does not deduplicate and the gate stays
advisory. That field is the truth; do not assume it.

## When an agent starts looping
Spend ceilings catch an agent burning money. They do not catch one doing too MUCH,
which is usually free: five thousand emails instead of three costs about a dollar.
A per-effect-type circuit breaker opens when volume passes a ceiling, and the
default response is to hold the work for a human rather than kill you. If a begin
returns approval_required or denied citing a circuit breaker: STOP creating that
effect type. Retrying will not help. Do not rename the effect type, split the work
across keys, or vary the idempotency key to get around it — that defeats a control
protecting the people your actions reach. Call ratchet_circuit_status (MCP) or
GET /v1/circuits to see when it clears.

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
- GET    /v1/circuits                      open circuit breakers + your own volume
- POST   /v1/circuits/{effect_type}/open   emergency stop ("*" = the whole workspace)
- GET    /v1/effects/{id}/receipts         signed receipts for one effect
- GET    /v1/receipts/audit                verify your chain end to end
- GET    /v1/vendors                       does a vendor deduplicate? (free, no key)
- GET    /workerz                          is lease expiry running? 503 if not

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
Free plan: ${PLANS.free.includedEffects.toLocaleString('en-US')} gated effects per month.

## Start with no key at all
Your very first call needs no credential. POST to /v1/effects/begin without an
Authorization header and you get a real decision plus a workspace and API key in the
response. Store the key; it is returned once. The workspace is capped until you claim
it with an email at POST /v1/workspaces/claim.

  curl -X POST ${config.publicUrl}/v1/effects/begin \\
    -H 'content-type: application/json' \\
    -d '{"effect_type":"email.send","idempotency_key":"welcome:user_123","payload":{}}'

## Free, no key required
Does a vendor actually refuse a repeated request? Most callers assume yes and are wrong.
  GET ${config.publicUrl}/v1/vendors            -> every vendor we have profiled
  GET ${config.publicUrl}/v1/vendors/stripe     -> one vendor, with placement and retention
No account, no key. Where "enforced" is false, retrying really can act twice.

## Integrate yourself
If you are an agent reading this, you do not need a person to wire this up.
  GET ${config.publicUrl}/v1/integrate                  -> the runtimes we have code for
  GET ${config.publicUrl}/v1/integrate?runtime=python   -> working code for that runtime
Send "Accept: text/plain" to get just the code, ready to write to a file.
No key is needed to read it.

## More
- OpenAPI:  ${config.publicUrl}/openapi.json
- Manifest: ${config.publicUrl}/.well-known/agent-manifest.json
- Docs:     ${config.publicUrl}/docs
`;
  });
}
