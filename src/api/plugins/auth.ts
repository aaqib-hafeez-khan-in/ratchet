import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type {} from '@fastify/cookie';
import { authenticate, requireScope, resolveConsoleSession, provisionAnonymousWorkspace,
         ANONYMOUS_EFFECT_QUOTA,
         type AuthContext, type Scope } from '../../domain/auth.js';
import { PLANS, type PlanCapabilities } from '../../domain/plans.js';
import { errors } from '../../lib/errors.js';
import { claimProvisionSlot } from '../../domain/provisioning.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    console?: { workspaceId: string; email: string };
    /** Set when this request provisioned its own workspace; returned once. */
    provisionedKey?: { api_key: string; workspace_id: string; quota: number };
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string' && alt.length > 0) return alt;
  return null;
}


/** Said to a caller who cannot use something, so it names the thing not the flag. */
const CAPABILITY_LABEL: Record<keyof PlanCapabilities, string> = {
  reversibleGroups: 'reversible effect groups',
  signedReceipts: 'signed receipts',
  reconciliation: 'reconciliation',
};

async function plugin(app: FastifyInstance) {
  /** Guard for agent-facing routes. Requires a scoped API key. */
  app.decorate('requireKey', (...scopes: Scope[]) => {
    return async (req: FastifyRequest) => {
      const token = bearer(req);
      if (!token) throw errors.unauthorized();
      const ctx = await authenticate(token);
      for (const s of scopes) requireScope(ctx, s);
      req.auth = ctx;
    };
  });

  /**
   * Gate a route on a plan capability, after some other guard has authenticated.
   *
   * Runs as a second preHandler rather than folding into requireKey/requireConsole,
   * because the two questions are genuinely separate — *who are you* and *may your
   * plan do this* — and a route that forgets the capability check should fail
   * closed at review rather than quietly serve a paid feature.
   *
   * A workspace that predates capability gating keeps everything, whatever its
   * plan says. See migration 029: taking a working feature away from somebody
   * already using it is a demotion, and this codebase has been one backfill away
   * from that once already.
   */
  app.decorate('requireCapability', (cap: keyof PlanCapabilities) => {
    return async (req: FastifyRequest) => {
      const ctx = req.auth;
      // Ordering bug rather than an auth failure: say so plainly instead of
      // returning a 401 that sends somebody looking at their credentials.
      if (!ctx) throw new Error(`requireCapability('${cap}') ran before authentication`);
      if (ctx.legacyCapabilities || ctx.plan.capabilities[cap]) return;

      const needed = (Object.keys(PLANS) as (keyof typeof PLANS)[])
        .find((id) => PLANS[id].capabilities[cap]);
      throw errors.forbidden(
        `The ${ctx.plan.name} plan does not include ${CAPABILITY_LABEL[cap]}.`
        + (needed ? ` It is available on ${PLANS[needed].name}.` : ''),
      );
    };
  });

  /**
   * Guard for the one route an agent can reach before it has anything.
   *
   * With a key it behaves exactly like requireKey. Without one it provisions a
   * small anonymous workspace and returns the key alongside the answer, so an
   * agent that just found this service can use it in a single call instead of
   * waiting for a person to go and sign up.
   *
   * This is an unauthenticated write, which is only acceptable because of what
   * it cannot do: it never reaches an existing workspace, only creates a new
   * empty one; the quota is small; and the rate limit is per IP. Nothing here
   * can read or affect anybody else's data.
   */
  app.decorate('requireKeyOrProvision', (...scopes: Scope[]) => {
    return async (req: FastifyRequest) => {
      const token = bearer(req);
      if (token) {
        const ctx = await authenticate(token);
        for (const s of scopes) requireScope(ctx, s);
        req.auth = ctx;
        return;
      }
      // Counted in Postgres, not in this process. See domain/provisioning.ts
      // for why the in-memory version was close to fictional.
      const slot = await claimProvisionSlot(req.ip);
      if (!slot.allowed) {
        throw errors.rateLimited(slot.scope === 'source'
          ? 'Too many workspaces provisioned from this address. Create one at '
            + '/v1/workspaces, or reuse the key from your first call.'
          // Deliberately says nothing about who else is calling, and points at
          // the path that still works. Anyone holding a key is unaffected.
          : 'Keyless provisioning is paused. Create a workspace at /v1/workspaces '
            + '— it takes one request and is not rate limited this way.');
      }
      const ws = await provisionAnonymousWorkspace();
      req.auth = await authenticate(ws.key.plaintext);
      req.provisionedKey = {
        api_key: ws.key.plaintext,
        workspace_id: ws.workspaceId,
        quota: ANONYMOUS_EFFECT_QUOTA,
      };
    };
  });

  /**
   * Guard for console routes. Accepts a session cookie, or an API key with the
   * needed scope so the console flow is scriptable.
   */
  app.decorate('requireConsole', (...scopes: Scope[]) => {
    return async (req: FastifyRequest) => {
      const raw = req.cookies?.rk_session;
      if (raw) {
        const sess = await resolveConsoleSession(raw);
        if (sess) {
          req.console = sess;
          return;
        }
      }
      const token = bearer(req);
      if (!token) throw errors.unauthorized('Sign in or present an API key.');
      const ctx = await authenticate(token);
      for (const s of scopes) requireScope(ctx, s);
      req.auth = ctx;
      req.console = { workspaceId: ctx.workspaceId, email: `key:${ctx.keyPrefix}` };
    };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireKey: (...scopes: Scope[]) => (req: FastifyRequest) => Promise<void>;
    requireConsole: (...scopes: Scope[]) => (req: FastifyRequest) => Promise<void>;
    requireCapability: (cap: keyof PlanCapabilities) => (req: FastifyRequest) => Promise<void>;
    requireKeyOrProvision: (...scopes: Scope[]) => (req: FastifyRequest) => Promise<void>;
  }
}

export default fp(plugin, { name: 'ratchet-auth' });

/** Workspace id for whichever credential authenticated the request. */
export function wsOf(req: FastifyRequest): string {
  const id = req.auth?.workspaceId ?? req.console?.workspaceId;
  if (!id) throw errors.unauthorized();
  return id;
}

export function actorOf(req: FastifyRequest): string {
  if (req.auth) return `key:${req.auth.keyPrefix}`;
  if (req.console) return `console:${req.console.email}`;
  return 'system';
}
