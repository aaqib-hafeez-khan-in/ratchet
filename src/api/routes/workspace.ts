import type { FastifyInstance } from 'fastify';
import type {} from '@fastify/cookie';
import { getPool } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { wsOf, actorOf } from '../plugins/auth.js';
import { createWorkspace, getWorkspace, createApiKey, listApiKeys, revokeApiKey,
         createConsoleSession, destroyConsoleSession, isScope, SCOPES, DEFAULT_AGENT_SCOPES, type Scope } from '../../domain/auth.js';
import { listPolicies, upsertPolicy, deletePolicy, getPolicy } from '../../domain/policy.js';
import { getSpendSummary } from '../../domain/budget.js';
import { listLedger } from '../../domain/metering.js';
import { listAudit, audit } from '../../domain/audit.js';
import { listWebhookEndpoints, listDeliveries, EVENT_TYPES } from '../../domain/events.js';
import { validateWebhookUrl, UnsafeUrlError } from '../../lib/ssrf.js';
import { newId } from '../../lib/ids.js';
import { randomBytes } from 'node:crypto';
import { policySchema, errorResponses } from '../schemas.js';
import { policyOut } from '../serialize.js';
import { PLANS } from '../../domain/plans.js';
import { config } from '../../lib/config.js';

export default async function workspaceRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------- onboarding
  app.post('/workspaces', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: {
      tags: ['Workspace'], operationId: 'createWorkspace',
      summary: 'Create a workspace and its first API key',
      description:
        'Self-serve signup. Returns the API key exactly once — it is stored only as a keyed ' +
        'hash and cannot be retrieved again. Also returns a console session cookie.',
      body: {
        type: 'object', required: ['name', 'email'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          email: { type: 'string', format: 'email', maxLength: 254 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            workspace_id: { type: 'string' },
            name: { type: 'string' },
            api_key: { type: 'string', description: 'Shown once. Store it securely.' },
            api_key_prefix: { type: 'string' },
            plan: { type: 'string' },
            console_url: { type: 'string' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const b = req.body as { name: string; email: string };
    const ws = await createWorkspace(b.name, b.email);
    const session = await createConsoleSession(ws.workspaceId, ws.email);
    reply.setCookie('rk_session', session, {
      httpOnly: true, sameSite: 'lax', secure: config.isProd,
      path: '/', maxAge: config.consoleSessionTtlHours * 3600,
    });
    reply.code(201);
    return {
      workspace_id: ws.workspaceId,
      name: ws.name,
      api_key: ws.key.plaintext,
      api_key_prefix: ws.key.prefix,
      plan: 'free',
      console_url: `${config.publicUrl}/console`,
    };
  });

  app.post('/console/signout', {
    schema: {
      tags: ['Workspace'], operationId: 'consoleSignOut',
      summary: 'Destroy the console session cookie',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const raw = req.cookies?.rk_session;
    if (raw) await destroyConsoleSession(raw);
    reply.clearCookie('rk_session', { path: '/' });
    return { signed_out: true };
  });

  app.get('/workspace', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Workspace'], operationId: 'getWorkspace',
      summary: 'Plan, prepaid balance, and current-period usage',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ws = await getWorkspace(getPool(), wsOf(req));
    if (!ws) throw errors.notFound('Workspace not found.');
    const spend = await getSpendSummary(getPool(), ws.workspaceId);
    return {
      workspace_id: ws.workspaceId, name: ws.name, status: ws.status,
      plan: {
        id: ws.plan.id, name: ws.plan.name,
        included_effects: ws.plan.includedEffects,
        overage_micros_per_effect: ws.plan.overageMicrosPerEffect,
        rate_limit_per_minute: ws.plan.rateLimitPerMinute,
        max_retention_days: ws.plan.maxRetentionDays,
      },
      credit_micros: ws.creditMicros,
      usage: {
        period_start: ws.usage.periodStart,
        effects_this_period: ws.usage.effectsThisPeriod,
        included_remaining: ws.usage.includedRemaining,
      },
      external_spend_today: {
        day: spend.day,
        workspace_micros: spend.workspaceMicros,
        by_scope: spend.byScope,
      },
      created_at: ws.createdAt,
    };
  });

  // ---------------------------------------------------------------- api keys
  app.get('/keys', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Workspace'], operationId: 'listApiKeys', summary: 'List API keys (secrets are never returned)',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => ({ data: await listApiKeys(getPool(), wsOf(req)) }));

  app.post('/keys', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Workspace'], operationId: 'createApiKey',
      summary: 'Mint a scoped API key',
      description: 'Grant only the scopes an agent needs. A worker that performs effects needs ' +
        'effects:begin and effects:report, and nothing else.',
      body: {
        type: 'object', required: ['name'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          scopes: { type: 'array', items: { type: 'string', enum: [...SCOPES] }, maxItems: 10 },
          daily_budget_micros: { type: ['integer', 'null'], minimum: 0,
            description: 'Hard ceiling on external spend this key may declare per UTC day.' },
        },
      },
      response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const b = req.body as Record<string, any>;
    const workspaceId = wsOf(req);
    const ws = await getWorkspace(getPool(), workspaceId);
    const existing = await listApiKeys(getPool(), workspaceId);
    const plan = PLANS[(ws?.plan.id ?? 'free') as keyof typeof PLANS];
    if (existing.filter((k) => !k.revoked).length >= plan.maxApiKeys) {
      throw errors.forbidden(`The ${plan.name} plan allows ${plan.maxApiKeys} active API keys.`);
    }
    const scopes: Scope[] = (b.scopes ?? DEFAULT_AGENT_SCOPES).filter(isScope);
    const key = await createApiKey(getPool(), workspaceId, b.name, scopes, b.daily_budget_micros ?? null);
    await audit(getPool(), workspaceId, 'key.created', actorOf(req), key.id, { name: b.name, scopes });
    // A security notice, so a key minted by someone else is visible immediately.
    void (async () => {
      const [{ queueEmail }, tpl] = await Promise.all([
        import('../../domain/email.js'), import('../../domain/email-templates.js')]);
      const t = tpl.keyCreated(b.name, key.prefix, scopes);
      await queueEmail({ workspaceId, category: 'security',
        dedupeKey: `key:${key.id}`, subject: t.subject, text: t.text, html: t.html });
    })().catch(() => {});
    reply.code(201);
    return { id: key.id, prefix: key.prefix, api_key: key.plaintext, scopes };
  });

  app.delete('/keys/:keyId', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Workspace'], operationId: 'revokeApiKey', summary: 'Revoke an API key immediately',
      params: { type: 'object', required: ['keyId'], properties: { keyId: { type: 'string' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const workspaceId = wsOf(req);
    const keyId = (req.params as { keyId: string }).keyId;
    const ok = await revokeApiKey(getPool(), workspaceId, keyId);
    if (!ok) throw errors.notFound('No such active key in this workspace.');
    await audit(getPool(), workspaceId, 'key.revoked', actorOf(req), keyId);
    return { revoked: true, id: keyId };
  });

  // ---------------------------------------------------------------- policies
  app.get('/policies', {
    preHandler: app.requireConsole('policies:read'),
    schema: {
      tags: ['Policies'], operationId: 'listPolicies',
      summary: 'List configured effect-type policies',
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: policySchema } } },
        ...errorResponses,
      },
    },
  }, async (req) => ({ data: (await listPolicies(getPool(), wsOf(req))).map(policyOut) }));

  app.get('/policies/:effectType', {
    preHandler: app.requireConsole('policies:read'),
    schema: {
      tags: ['Policies'], operationId: 'getPolicy',
      summary: 'Resolve the effective policy for an effect type',
      description: 'Returns the workspace default with is_default=true when no explicit policy exists.',
      params: { type: 'object', required: ['effectType'], properties: { effectType: { type: 'string' } } },
      response: { 200: policySchema, ...errorResponses },
    },
  }, async (req) => policyOut(await getPolicy(getPool(), wsOf(req),
      (req.params as { effectType: string }).effectType)));

  app.put('/policies/:effectType', {
    preHandler: app.requireConsole('policies:write'),
    schema: {
      tags: ['Policies'], operationId: 'upsertPolicy',
      summary: 'Create or replace the policy for an effect type',
      description:
        'on_indeterminate is the important field. "block" (the default) refuses to auto-retry ' +
        'an effect whose real-world outcome is unknown. Use "retry" only when the underlying ' +
        'vendor is genuinely idempotent, and "probe" when a caller must verify first.',
      params: { type: 'object', required: ['effectType'], properties: { effectType: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['allow', 'require_approval', 'deny'] },
          on_indeterminate: { type: 'string', enum: ['block', 'retry', 'probe'] },
          lease_seconds: { type: 'integer', minimum: 5, maximum: 3600 },
          max_attempts: { type: 'integer', minimum: 1, maximum: 50 },
          max_cost_micros: { type: ['integer', 'null'], minimum: 0 },
          daily_budget_micros: { type: ['integer', 'null'], minimum: 0 },
          retention_days: { type: 'integer', minimum: 1, maximum: 400 },
        },
      },
      response: { 200: policySchema, ...errorResponses },
    },
  }, async (req) => {
    const workspaceId = wsOf(req);
    const effectType = (req.params as { effectType: string }).effectType;
    const b = (req.body ?? {}) as Record<string, any>;
    const ws = await getWorkspace(getPool(), workspaceId);
    const maxRetention = ws?.plan.maxRetentionDays ?? 7;
    if (b.retention_days && b.retention_days > maxRetention) {
      throw errors.forbidden(
        `The ${ws?.plan.name} plan retains effect records for at most ${maxRetention} days.`,
        { maxRetentionDays: maxRetention });
    }
    const p = await upsertPolicy(getPool(), workspaceId, {
      effectType,
      mode: b.mode, onIndeterminate: b.on_indeterminate,
      leaseSeconds: b.lease_seconds, maxAttempts: b.max_attempts,
      maxCostMicros: b.max_cost_micros, dailyBudgetMicros: b.daily_budget_micros,
      retentionDays: b.retention_days,
    });
    await audit(getPool(), workspaceId, 'policy.updated', actorOf(req), effectType, b);
    return policyOut(p);
  });

  app.delete('/policies/:effectType', {
    preHandler: app.requireConsole('policies:write'),
    schema: {
      tags: ['Policies'], operationId: 'deletePolicy',
      summary: 'Remove a policy and fall back to workspace defaults',
      params: { type: 'object', required: ['effectType'], properties: { effectType: { type: 'string' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const effectType = (req.params as { effectType: string }).effectType;
    const ok = await deletePolicy(getPool(), wsOf(req), effectType);
    if (!ok) throw errors.notFound('No explicit policy for that effect type.');
    return { deleted: true, effect_type: effectType };
  });

  // ---------------------------------------------------------------- webhooks
  app.get('/webhooks', {
    preHandler: app.requireConsole('workspace:read'),
    schema: { tags: ['Webhooks'], operationId: 'listWebhooks', summary: 'List webhook endpoints',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => ({ data: await listWebhookEndpoints(getPool(), wsOf(req)) }));

  app.post('/webhooks', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Webhooks'], operationId: 'createWebhook',
      summary: 'Register a signed webhook endpoint',
      description:
        'Destinations must be https DNS hostnames on port 80/443. Private, loopback, and ' +
        'link-local addresses are refused both at registration and again at delivery time. ' +
        'Redirects are never followed. The signing secret is returned once.',
      body: {
        type: 'object', required: ['url', 'events'], additionalProperties: false,
        properties: {
          url: { type: 'string', maxLength: 2048 },
          events: { type: 'array', minItems: 1, maxItems: 20,
            items: { type: 'string', enum: [...EVENT_TYPES] } },
        },
      },
      response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const b = req.body as { url: string; events: string[] };
    const workspaceId = wsOf(req);
    try {
      validateWebhookUrl(b.url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw errors.invalid(err.reason);
      throw err;
    }
    const ws = await getWorkspace(getPool(), workspaceId);
    const plan = PLANS[(ws?.plan.id ?? 'free') as keyof typeof PLANS];
    const existing = await listWebhookEndpoints(getPool(), workspaceId);
    if (existing.filter((e) => !e.disabled).length >= plan.maxWebhookEndpoints) {
      throw errors.forbidden(`The ${plan.name} plan allows ${plan.maxWebhookEndpoints} webhook endpoint(s).`);
    }
    const id = newId('whe');
    const secret = randomBytes(24).toString('base64url');
    await getPool().query(
      `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, workspaceId, b.url, secret, b.events],
    );
    await audit(getPool(), workspaceId, 'webhook.created', actorOf(req), id, { url: b.url, events: b.events });
    reply.code(201);
    return { id, url: b.url, events: b.events, signing_secret: secret };
  });

  app.delete('/webhooks/:id', {
    preHandler: app.requireConsole('workspace:read'),
    schema: { tags: ['Webhooks'], operationId: 'deleteWebhook', summary: 'Disable a webhook endpoint',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => {
    const id = (req.params as { id: string }).id;
    const res = await getPool().query(
      `UPDATE webhook_endpoints SET disabled_at = now()
        WHERE id=$1 AND workspace_id=$2 AND disabled_at IS NULL`,
      [id, wsOf(req)],
    );
    if ((res.rowCount ?? 0) === 0) throw errors.notFound('No such active webhook endpoint.');
    return { disabled: true, id };
  });

  app.get('/webhooks/deliveries', {
    preHandler: app.requireConsole('workspace:read'),
    schema: { tags: ['Webhooks'], operationId: 'listWebhookDeliveries', summary: 'Recent delivery attempts',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => ({ data: await listDeliveries(getPool(), wsOf(req)) }));

  // ---------------------------------------------------------------- email
  app.get('/email/preferences', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Workspace'], operationId: 'getEmailPreferences',
      summary: 'Which alerts this workspace receives',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const { getPreferences, emailEnabled } = await import('../../domain/email.js');
    const { rows } = await getPool().query<{ owner_email: string; email_suppressed_at: Date | null;
                                             email_suppress_reason: string | null }>(
      'SELECT owner_email, email_suppressed_at, email_suppress_reason FROM workspaces WHERE id=$1',
      [wsOf(req)]);
    return {
      to: rows[0]?.owner_email ?? null,
      suppressed: rows[0]?.email_suppressed_at !== null,
      suppress_reason: rows[0]?.email_suppress_reason ?? null,
      delivery_configured: emailEnabled(),
      preferences: await getPreferences(getPool(), wsOf(req)),
    };
  });

  app.put('/email/preferences/:category', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Workspace'], operationId: 'setEmailPreference',
      summary: 'Turn one alert category on or off',
      params: { type: 'object', required: ['category'], properties: { category: { type: 'string' } } },
      body: {
        type: 'object', required: ['enabled'], additionalProperties: false,
        properties: { enabled: { type: 'boolean' } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const { setPreference, CATEGORIES } = await import('../../domain/email.js');
    const category = (req.params as { category: string }).category;
    if (!(category in CATEGORIES)) throw errors.invalid('Unknown alert category.');
    const enabled = (req.body as { enabled: boolean }).enabled;
    await setPreference(wsOf(req), category as never, enabled);
    return { category, enabled };
  });

  app.get('/email/messages', {
    preHandler: app.requireConsole('workspace:read'),
    schema: {
      tags: ['Workspace'], operationId: 'listEmails',
      summary: 'Recent alerts sent to this workspace',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const { listEmails } = await import('../../domain/email.js');
    return { data: await listEmails(getPool(), wsOf(req)) };
  });

  // ------------------------------------------------------------ observability
  app.get('/usage/ledger', {
    preHandler: app.requireConsole('workspace:read'),
    schema: { tags: ['Workspace'], operationId: 'listLedger',
      summary: 'Immutable record of every credit movement',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => ({ data: await listLedger(getPool(), wsOf(req)) }));

  app.get('/audit', {
    preHandler: app.requireConsole('workspace:read'),
    schema: { tags: ['Workspace'], operationId: 'listAudit', summary: 'Audit trail',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => ({ data: await listAudit(getPool(), wsOf(req)) }));
}
