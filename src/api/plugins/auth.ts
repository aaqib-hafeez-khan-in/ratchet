import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type {} from '@fastify/cookie';
import { authenticate, requireScope, resolveConsoleSession, type AuthContext, type Scope } from '../../domain/auth.js';
import { errors } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    console?: { workspaceId: string; email: string };
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string' && alt.length > 0) return alt;
  return null;
}

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
