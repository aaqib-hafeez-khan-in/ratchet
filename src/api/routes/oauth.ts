// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { stricterThan } from '../rate-limit.js';
/**
 * OAuth 2.1 endpoints.
 *
 * Client metadata reaches this file from unauthenticated dynamic registration,
 * so every value that renders into the consent page is attacker-controlled and
 * is escaped on the way out. The consent page carries no inline script — the
 * CSP forbids it, and a plain form needs none.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../../lib/config.js';
import { SCOPES, isScope, authenticate, createConsoleSession,
         resolveConsoleSession, listWorkspacesForEmail, workspaceOwnedBy,
         ownerEmailOf, type Scope, type WorkspaceChoice } from '../../domain/auth.js';
import { registerClient, findClient, clientSecretMatches, isAllowedRedirectUri,
         issueCode, redeemCode, issueTokens, refreshTokens, revokeToken,
         OAuthError } from '../../domain/oauth.js';

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const issuer = () => config.publicUrl.replace(/\/+$/, '');

/** Redirect an OAuth error back to the client, per RFC 6749 §4.1.2.1. */
function redirectError(
  reply: FastifyReply, redirectUri: string, error: string, description: string, state?: string,
) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return reply.redirect(u.toString(), 302);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Ratchet</title>
<meta name="robots" content="noindex, nofollow, noarchive">
<link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.css">
</head><body><main id="main"><section><div class="wrap narrow">
${body}
</div></section></main></body></html>`;
}

export default async function oauthRoutes(app: FastifyInstance) {
  // Belt and braces alongside the meta tag: a crawler that does not parse the
  // body still gets the directive, and this also covers the redirects.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/oauth/')) reply.header('X-Robots-Tag', 'noindex, nofollow');
    return payload;
  });

  // ─────────────────────────────────────────────── discovery metadata

  // RFC 8414. Clients read this to learn where to send the user and the code.
  app.get('/.well-known/oauth-authorization-server', { schema: { hide: true } }, async () => ({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/oauth/authorize`,
    token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`,
    revocation_endpoint: `${issuer()}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. OAuth 2.1 removes "plain", and advertising it would invite it.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    service_documentation: `${issuer()}/docs`,
  }));

  // RFC 9728. This is what an MCP client fetches after a 401 to find the AS.
  const protectedResource = async () => ({
    resource: `${issuer()}/mcp`,
    authorization_servers: [issuer()],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: `${issuer()}/docs`,
  });
  app.get('/.well-known/oauth-protected-resource', { schema: { hide: true } }, protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', { schema: { hide: true } }, protectedResource);

  // ─────────────────────────────────────────────── dynamic registration

  /**
   * RFC 7591. Unauthenticated because the MCP spec requires it, which is safe
   * only because registration grants nothing: the row is inert until a human
   * signs in and approves it. Rate limited, because it is still a write.
   */
  app.post('/oauth/register', {
    schema: { hide: true },
    // Generous, because a shared egress IP — a corporate proxy, a connector
    // directory's servers — legitimately registers many clients, and a
    // registration grants nothing until a human approves it. Stale, never-used
    // clients are swept by the worker, so this only has to bound growth.
    config: { rateLimit: stricterThan(100, '1 hour') },
  }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];

    if (!uris.length) {
      reply.code(400);
      return { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required.' };
    }
    if (uris.length > 8) {
      reply.code(400);
      return { error: 'invalid_redirect_uri', error_description: 'Too many redirect_uris.' };
    }
    for (const u of uris) {
      if (!isAllowedRedirectUri(u)) {
        reply.code(400);
        return { error: 'invalid_redirect_uri',
                 error_description: `Not an acceptable redirect URI: ${u}. Use https, a loopback `
                   + 'http address, or a private-use scheme.' };
      }
    }

    const requested = typeof b.scope === 'string' ? b.scope.split(/\s+/).filter(isScope) : [];
    // Never widen beyond what an agent needs. An OAuth client asking for
    // effects:admin gets it only if it said so, and never gets more by default.
    const scopes: Scope[] = requested.length ? requested : ['effects:begin', 'effects:report', 'effects:read'];

    const name = typeof b.client_name === 'string' && b.client_name.trim()
      ? b.client_name.trim().slice(0, 120) : 'Unnamed client';
    const confidential = b.token_endpoint_auth_method !== undefined
      && b.token_endpoint_auth_method !== 'none';

    const c = await registerClient({ name, redirectUris: uris, scopes, confidential });
    reply.code(201);
    return {
      client_id: c.clientId,
      ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
      client_name: c.name,
      redirect_uris: c.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: c.scopes.join(' '),
      token_endpoint_auth_method: c.clientSecret ? 'client_secret_post' : 'none',
    };
  });

  // ─────────────────────────────────────────────── authorization

  interface AuthzParams {
    response_type?: string; client_id?: string; redirect_uri?: string;
    code_challenge?: string; code_challenge_method?: string;
    state?: string; scope?: string; resource?: string;
  }

  function consentPage(q: AuthzParams, clientName: string, scopes: Scope[], signedIn: boolean,
                       error?: string,
                       choices: WorkspaceChoice[] = [], chosenId?: string): string {
    // The workspace choice is rendered as a control, never as a hidden field —
    // a hidden copy would silently win over whatever the user picked.
    const hidden = Object.entries(q)
      .filter(([k, v]) => typeof v === 'string' && v && k !== 'workspace_id')
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');

    if (!signedIn) {
      return page('Sign in', `
<p class="eyebrow">Authorize</p>
<h1>Sign in to continue</h1>
<p class="dim">An application calling itself <strong>${esc(clientName)}</strong> is asking for
  access to a Ratchet workspace. That name is supplied by the application itself and is
  <em>not</em> verified by us.</p>
<p class="dim">Paste a <strong>Ratchet API key</strong> — the one starting <code>rk_</code> from
  your Ratchet console. Never enter a password or a key belonging to any other service here.</p>
${error ? `<p style="color:var(--stop)">${esc(error)}</p>` : ''}
<form method="POST" action="/oauth/authorize">
${hidden}
  <p><label for="api_key">API key</label><br>
  <input id="api_key" name="api_key" type="password" autocomplete="off" required
         placeholder="rk_live_…" style="width:100%;padding:.7rem;font-family:var(--mono)"></p>
  <button class="btn" type="submit">Continue</button>
</form>
<p class="small dim">Your key is exchanged for a browser session and is never given to the
  application. It receives its own scoped, revocable token instead. If you did not start this
  from your own tooling, close this page.</p>`);
    }

    const usable = choices.filter((w) => w.status === 'active');
    const picker = usable.length > 1
      ? `<fieldset style="border:1px solid var(--border);border-radius:var(--radius);padding:1rem">
  <legend class="small dim">Which workspace?</legend>
  ${usable.map((w) => `<p style="margin:.35rem 0"><label>
    <input type="radio" name="workspace_id" value="${esc(w.id)}"${
      w.id === chosenId ? ' checked' : ''}>
    ${esc(w.name)} <span class="small dim">${esc(w.plan)} · ${esc(w.id)}</span>
  </label></p>`).join('\n')}
</fieldset>`
      : usable.length === 1
        ? `<input type="hidden" name="workspace_id" value="${esc(usable[0]!.id)}">
<p class="small dim">Workspace: <strong>${esc(usable[0]!.name)}</strong>
  <span class="dim">(${esc(usable[0]!.id)})</span></p>`
        : '';

    return page('Authorize', `
<p class="eyebrow">Authorize</p>
<h1>Allow <strong>${esc(clientName)}</strong> to act through Ratchet?</h1>
<p class="dim">It will be able to:</p>
<ul>
${scopes.map((s) => `<li><code>${esc(s)}</code> — ${esc(SCOPE_COPY[s] ?? s)}</li>`).join('\n')}
</ul>
${picker}
<p class="small dim">Ratchet never performs side effects itself, so this does not let
  ${esc(clientName)} send email, move money, or reach your vendors. It lets it ask for and
  record permission. You can revoke this at any time from the console.</p>
${error ? `<p style="color:var(--stop)">${esc(error)}</p>` : ''}
<form method="POST" action="/oauth/authorize">
${hidden}
  <div class="actions">
    <button class="btn" type="submit" name="decision" value="allow">Allow</button>
    <button class="btn secondary" type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`);
  }

  const SCOPE_COPY: Partial<Record<Scope, string>> = {
    'effects:begin': 'ask permission before performing a side effect',
    'effects:report': 'record what happened after acting',
    'effects:read': 'read effect records and results',
    'effects:admin': 'resolve, cancel, and approve effects',
  };

  /**
   * Validate the client and redirect URI BEFORE anything else. An error can
   * only be sent back to a redirect URI that is genuinely registered to the
   * client — otherwise this endpoint would be an open redirect.
   */
  async function validate(q: AuthzParams) {
    if (!q.client_id) return { fatal: 'client_id is required.' };
    const client = await findClient(q.client_id);
    if (!client) return { fatal: 'Unknown client_id.' };
    if (!q.redirect_uri) return { fatal: 'redirect_uri is required.' };
    if (!client.redirectUris.includes(q.redirect_uri)) {
      return { fatal: 'redirect_uri is not registered for this client.' };
    }
    return { client };
  }

  app.get('/oauth/authorize', {
    schema: { hide: true },
    config: { rateLimit: stricterThan(60, '1 minute') },
  }, async (req, reply) => {
    const q = req.query as AuthzParams;
    const v = await validate(q);
    if (v.fatal) {
      reply.code(400).type('text/html; charset=utf-8');
      return page('Invalid request', `<h1>Invalid authorization request</h1>
        <p class="dim">${esc(v.fatal)}</p>`);
    }
    const client = v.client!;

    // From here the client is known, so errors go back to it.
    if (q.response_type !== 'code') {
      return redirectError(reply, q.redirect_uri!, 'unsupported_response_type',
        'Only response_type=code is supported.', q.state);
    }
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return redirectError(reply, q.redirect_uri!, 'invalid_request',
        'PKCE is required: send code_challenge with code_challenge_method=S256.', q.state);
    }

    const wanted = q.scope ? q.scope.split(/\s+/).filter(isScope) : client.scopes;
    const granted = wanted.filter((s) => client.scopes.includes(s));
    if (!granted.length) {
      return redirectError(reply, q.redirect_uri!, 'invalid_scope',
        'No requested scope is registered for this client.', q.state);
    }

    const sess = req.cookies?.rk_session
      ? await resolveConsoleSession(req.cookies.rk_session) : null;
    const choices = sess ? await listWorkspacesForEmail(sess.email) : [];

    reply.type('text/html; charset=utf-8');
    return consentPage(q, client.name, granted, Boolean(sess), undefined,
                       choices, sess?.workspaceId);
  });

  app.post('/oauth/authorize', {
    schema: { hide: true },
    config: { rateLimit: stricterThan(60, '1 minute') },
  }, async (req, reply) => {
    const b = (req.body ?? {}) as AuthzParams
      & { api_key?: string; decision?: string; workspace_id?: string };

    // The session cookie is SameSite=Lax, so a cross-site POST does not carry
    // it. Checking Origin as well costs nothing and closes the same door twice.
    const origin = req.headers.origin;
    if (origin && origin !== issuer()) {
      reply.code(403).type('text/html; charset=utf-8');
      return page('Blocked', '<h1>Blocked</h1><p class="dim">Cross-origin form submission.</p>');
    }

    const v = await validate(b);
    if (v.fatal) {
      reply.code(400).type('text/html; charset=utf-8');
      return page('Invalid request', `<h1>Invalid authorization request</h1>
        <p class="dim">${esc(v.fatal)}</p>`);
    }
    const client = v.client!;
    if (!b.code_challenge || b.code_challenge_method !== 'S256') {
      return redirectError(reply, b.redirect_uri!, 'invalid_request',
        'PKCE is required.', b.state);
    }

    const wanted = b.scope ? b.scope.split(/\s+/).filter(isScope) : client.scopes;
    const granted = wanted.filter((s) => client.scopes.includes(s));

    // Identity only: the consent screen asks who you are and which workspace
    // you are authorising, never what your plan includes.
    let sess: { workspaceId: string; email: string } | null = req.cookies?.rk_session
      ? await resolveConsoleSession(req.cookies.rk_session) : null;

    // Step one: exchange a pasted API key for a browser session.
    if (!sess && b.api_key) {
      try {
        const ctx = await authenticate(b.api_key);
        // The owning email, not a placeholder: it is the identity the workspace
        // picker resolves against, and a session without one can pick nothing.
        const email = await ownerEmailOf(ctx.workspaceId);
        if (!email) throw new Error('workspace has no owner');
        const raw = await createConsoleSession(ctx.workspaceId, email);
        reply.setCookie('rk_session', raw, {
          httpOnly: true, sameSite: 'lax', secure: config.isProd,
          path: '/', maxAge: config.consoleSessionTtlHours * 3600,
        });
        sess = { workspaceId: ctx.workspaceId, email };
      } catch {
        reply.code(401).type('text/html; charset=utf-8');
        return consentPage(b, client.name, granted, false, 'That API key was not accepted.');
      }
    }

    if (!sess) {
      reply.type('text/html; charset=utf-8');
      return consentPage(b, client.name, granted, false);
    }
    const choices = await listWorkspacesForEmail(sess.email);

    // Step two: the decision. An unanswered form re-renders rather than assuming.
    if (b.decision === 'deny') {
      return redirectError(reply, b.redirect_uri!, 'access_denied',
        'The user declined.', b.state);
    }
    if (b.decision !== 'allow') {
      reply.type('text/html; charset=utf-8');
      return consentPage(b, client.name, granted, true, undefined, choices, sess.workspaceId);
    }
    if (!granted.length) {
      return redirectError(reply, b.redirect_uri!, 'invalid_scope',
        'No requested scope is registered for this client.', b.state);
    }

    /**
     * Which workspace this grant is for.
     *
     * The id arrives from a form field the user controls, so it is checked
     * against the signed-in identity rather than trusted. Without this, a
     * session for one workspace could mint a token for any other by editing a
     * radio button — a cross-tenant escalation dressed up as a UI choice.
     */
    let grantWorkspaceId = sess.workspaceId;
    if (b.workspace_id && b.workspace_id !== sess.workspaceId) {
      const owned = await workspaceOwnedBy(sess.email, b.workspace_id);
      if (!owned) {
        reply.code(403).type('text/html; charset=utf-8');
        return consentPage(b, client.name, granted, true,
          'That workspace is not yours to authorise.', choices, sess.workspaceId);
      }
      if (owned.status !== 'active') {
        reply.code(403).type('text/html; charset=utf-8');
        return consentPage(b, client.name, granted, true,
          'That workspace is suspended.', choices, sess.workspaceId);
      }
      grantWorkspaceId = owned.id;
    }

    const code = await issueCode({
      clientId: client.id, workspaceId: grantWorkspaceId, redirectUri: b.redirect_uri!,
      codeChallenge: b.code_challenge, scopes: granted, resource: b.resource ?? null,
    });

    const u = new URL(b.redirect_uri!);
    u.searchParams.set('code', code);
    if (b.state) u.searchParams.set('state', b.state);
    return reply.redirect(u.toString(), 302);
  });

  // ─────────────────────────────────────────────── token

  app.post('/oauth/token', {
    schema: { hide: true },
    config: { rateLimit: stricterThan(120, '1 minute') },
  }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;

    // A token response must never be cached anywhere.
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');

    // client_secret_basic, as well as _post.
    let clientId = b.client_id;
    let clientSecret = b.client_secret;
    const authz = req.headers.authorization;
    if (typeof authz === 'string' && authz.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(authz.slice(6), 'base64').toString().split(':');
      clientId = clientId ?? id;
      clientSecret = clientSecret ?? secret;
    }

    try {
      if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.', 401);
      const client = await findClient(clientId);
      if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
      if (!clientSecretMatches(client, clientSecret)) {
        throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
      }

      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.redirect_uri || !b.code_verifier) {
          throw new OAuthError('invalid_request',
            'code, redirect_uri and code_verifier are required.');
        }
        const r = await redeemCode({
          code: b.code, clientId: client.id, redirectUri: b.redirect_uri,
          codeVerifier: b.code_verifier, resource: b.resource ?? null,
        });
        const t = await issueTokens({
          clientId: client.id, workspaceId: r.workspaceId, scopes: r.scopes,
          resource: r.resource, codeId: r.codeId,
        });
        return { access_token: t.accessToken, token_type: 'Bearer',
                 expires_in: t.expiresIn, refresh_token: t.refreshToken,
                 scope: t.scopes.join(' ') };
      }

      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token) {
          throw new OAuthError('invalid_request', 'refresh_token is required.');
        }
        const t = await refreshTokens({ refreshToken: b.refresh_token, clientId: client.id });
        return { access_token: t.accessToken, token_type: 'Bearer',
                 expires_in: t.expiresIn, refresh_token: t.refreshToken,
                 scope: t.scopes.join(' ') };
      }

      throw new OAuthError('unsupported_grant_type',
        'Only authorization_code and refresh_token are supported.');
    } catch (err) {
      if (err instanceof OAuthError) {
        reply.code(err.status);
        return { error: err.code, error_description: err.message };
      }
      throw err;
    }
  });

  // RFC 7009. Always answers 200, so it cannot be used to probe for valid tokens.
  app.post('/oauth/revoke', {
    schema: { hide: true },
    config: { rateLimit: stricterThan(60, '1 minute') },
  }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (b.token) await revokeToken(b.token);
    reply.code(200);
    return {};
  });
}
