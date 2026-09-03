/**
 * OAuth security properties.
 *
 * Registration here is unauthenticated by design, so client metadata is
 * attacker-controlled and every one of these is a real attack surface rather
 * than a hypothetical.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../../src/api/app.js';
import { freshWorkspace, closePool, getPool } from '../helpers.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { app = await buildApp(); await app.ready(); ws = await freshWorkspace(); });
after(async () => { await app.close(); await closePool(); });

const REDIRECT = 'http://127.0.0.1:33418/callback';
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(over: Record<string, unknown> = {}) {
  const r = await app.inject({ method: 'POST', url: '/oauth/register',
    payload: { client_name: 'Test Client', redirect_uris: [REDIRECT], ...over } });
  // A silent 429 here would surface much later as a confusing 400 from the
  // authorize endpoint, which is exactly what it did once.
  if (r.statusCode === 429) assert.fail('registration was rate limited — the test exhausted the limit');
  return { status: r.statusCode, body: r.json() };
}

/** Register, consent, and redeem — returning the tokens a real client would hold. */
async function fullFlow(opts: { resource?: string; key?: string } = {}) {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st',
    ...(opts.resource ? { resource: opts.resource } : {}) };

  const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
    payload: form({ ...base, api_key: opts.key ?? ws.key.plaintext, decision: 'allow' }) });
  assert.equal(consent.statusCode, 302, 'consent did not redirect');
  const code = new URL(consent.headers.location as string).searchParams.get('code')!;

  const tok = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
    payload: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
      code_verifier: verifier, client_id: client.client_id,
      ...(opts.resource ? { resource: opts.resource } : {}) }) });
  return { client, code, verifier, tokens: tok.json(), tokenStatus: tok.statusCode };
}

/*
 * These tests probe "does this token grant access?" by making a call and
 * checking the status. The probe used to be tools/list, which is now public and
 * deliberately ignores the credential — so it stopped being able to tell an
 * accepted token from a refused one, and every one of these passed or failed
 * for the wrong reason.
 *
 * ratchet_get_usage is the probe now: read-only, no required arguments, no side
 * effect, and it needs a credential like any other tool call. The properties
 * being pinned — audience binding, revocation, replay defence — are unchanged.
 */
describe('OAuth — registration', () => {
  test('a javascript: redirect URI is refused', async () => {
    const r = await register({ redirect_uris: ['javascript:alert(1)'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_redirect_uri');
  });

  test('non-loopback http is refused; loopback and https are allowed', async () => {
    assert.equal((await register({ redirect_uris: ['http://evil.example/cb'] })).status, 400);
    assert.equal((await register({ redirect_uris: ['https://app.example/cb'] })).status, 201);
    assert.equal((await register({ redirect_uris: ['http://localhost:9/cb'] })).status, 201);
  });

  test('registration never grants access on its own', async () => {
    const { body } = await register();
    // A freshly registered client holds no token and can reach nothing.
    const r = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${body.client_id}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_get_usage', arguments: {} } } });
    assert.equal(r.statusCode, 401);
  });
});

describe('OAuth — the authorize endpoint is not an open redirect', () => {
  test('an unregistered redirect_uri is never redirected to', async () => {
    const { body: client } = await register();
    const r = await app.inject({ method: 'GET', url: '/oauth/authorize?' + form({
      response_type: 'code', client_id: client.client_id,
      redirect_uri: 'https://attacker.example/steal',
      code_challenge: pkce().challenge, code_challenge_method: 'S256' }) });
    assert.equal(r.statusCode, 400);
    assert.equal(r.headers.location, undefined, 'redirected to an unregistered URI');
    assert.doesNotMatch(r.body, /attacker\.example/, 'reflected the attacker URI');
  });

  test('an unknown client_id is not redirected anywhere', async () => {
    const r = await app.inject({ method: 'GET', url: '/oauth/authorize?' + form({
      response_type: 'code', client_id: 'oc_nope', redirect_uri: 'https://attacker.example/x',
      code_challenge: pkce().challenge, code_challenge_method: 'S256' }) });
    assert.equal(r.statusCode, 400);
    assert.equal(r.headers.location, undefined);
  });
});

describe('OAuth — PKCE is mandatory', () => {
  test('a missing challenge is refused', async () => {
    const { body: client } = await register();
    const r = await app.inject({ method: 'GET', url: '/oauth/authorize?' + form({
      response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT }) });
    assert.equal(r.statusCode, 302);
    assert.match(r.headers.location as string, /error=invalid_request/);
  });

  test('the "plain" method is refused, and never advertised', async () => {
    const { body: client } = await register();
    const r = await app.inject({ method: 'GET', url: '/oauth/authorize?' + form({
      response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
      code_challenge: 'whatever', code_challenge_method: 'plain' }) });
    assert.match(r.headers.location as string, /error=invalid_request/);

    const meta = (await app.inject({ method: 'GET',
      url: '/.well-known/oauth-authorization-server' })).json();
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.ok(!meta.grant_types_supported.includes('implicit'));
    assert.ok(!meta.grant_types_supported.includes('password'));
  });

  test('a wrong code_verifier cannot redeem the code', async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256',
        api_key: ws.key.plaintext, decision: 'allow' }) });
    const code = new URL(consent.headers.location as string).searchParams.get('code')!;

    const r = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        code_verifier: randomBytes(48).toString('base64url'), client_id: client.client_id }) });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'invalid_grant');
  });
});

describe('OAuth — authorization codes', () => {
  test('a replayed code is refused AND revokes every token it produced', async () => {
    const f = await fullFlow();
    assert.equal(f.tokenStatus, 200);
    const access = f.tokens.access_token;

    // The token works before the replay.
    const before = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${access}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_get_usage', arguments: {} } } });
    assert.ok(before.json().result, 'token should work before the replay');

    const replay = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'authorization_code', code: f.code, redirect_uri: REDIRECT,
        code_verifier: f.verifier, client_id: f.client.client_id }) });
    assert.equal(replay.json().error, 'invalid_grant');

    // A replay means the code leaked, so its descendants are no longer trusted.
    const after = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${access}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_get_usage', arguments: {} } } });
    assert.equal(after.statusCode, 401, 'tokens from a replayed code must be revoked');
  });

  test('a code cannot be redeemed by a different client', async () => {
    const { body: victim } = await register();
    const { body: attacker } = await register();
    const { verifier, challenge } = pkce();
    const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: victim.client_id, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256',
        api_key: ws.key.plaintext, decision: 'allow' }) });
    const code = new URL(consent.headers.location as string).searchParams.get('code')!;

    const r = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        code_verifier: verifier, client_id: attacker.client_id }) });
    assert.equal(r.json().error, 'invalid_grant');
  });

  test('a mismatched redirect_uri cannot redeem the code', async () => {
    const { body: client } = await register({
      redirect_uris: [REDIRECT, 'https://other.example/cb'] });
    const { verifier, challenge } = pkce();
    const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256',
        api_key: ws.key.plaintext, decision: 'allow' }) });
    const code = new URL(consent.headers.location as string).searchParams.get('code')!;

    const r = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'authorization_code', code, redirect_uri: 'https://other.example/cb',
        code_verifier: verifier, client_id: client.client_id }) });
    assert.equal(r.json().error, 'invalid_grant');
  });

  test('denying consent returns access_denied and no code', async () => {
    const { body: client } = await register();
    const r = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: pkce().challenge, code_challenge_method: 'S256',
        api_key: ws.key.plaintext, decision: 'deny' }) });
    const u = new URL(r.headers.location as string);
    assert.equal(u.searchParams.get('error'), 'access_denied');
    assert.equal(u.searchParams.get('code'), null);
  });
});

describe('OAuth — tokens are audience-bound', () => {
  test('a token minted for another resource is refused at /mcp', async () => {
    const f = await fullFlow({ resource: 'https://somewhere-else.example/mcp' });
    assert.equal(f.tokenStatus, 200);
    const r = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${f.tokens.access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_get_usage', arguments: {} } } });
    assert.equal(r.statusCode, 401, 'a token for another audience was accepted');
  });

  test('refresh rotates, and the old refresh token dies', async () => {
    const f = await fullFlow();
    const first = f.tokens.refresh_token;
    const r1 = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: first,
        client_id: f.client.client_id }) });
    assert.equal(r1.statusCode, 200);
    assert.notEqual(r1.json().refresh_token, first, 'refresh token was not rotated');

    const reuse = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: first,
        client_id: f.client.client_id }) });
    assert.equal(reuse.json().error, 'invalid_grant');
  });

  test('a revoked token stops working, and revoke never leaks validity', async () => {
    const f = await fullFlow();
    const r = await app.inject({ method: 'POST', url: '/oauth/revoke', headers: FORM,
      payload: form({ token: f.tokens.access_token }) });
    assert.equal(r.statusCode, 200);

    const after = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${f.tokens.access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_get_usage', arguments: {} } } });
    assert.equal(after.statusCode, 401);

    // A garbage token gets the same 200, so this cannot be used as an oracle.
    const bogus = await app.inject({ method: 'POST', url: '/oauth/revoke', headers: FORM,
      payload: form({ token: 'rk_oat_000000000000_' + 'x'.repeat(40) }) });
    assert.equal(bogus.statusCode, 200);
  });

  test('a token reaches only the workspace that authorised it', async () => {
    const other = await freshWorkspace();
    const f = await fullFlow();                      // authorised against `ws`
    const r = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${f.tokens.access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_begin_effect', arguments: {
          effect_type: 'email.send', idempotency_key: `iso-${Date.now()}`, payload: {} } } } });
    const effectId = r.json().result?.structuredContent?.effect_id;
    assert.ok(effectId,
      `the call should succeed for its own workspace; got ${r.statusCode} ${r.body.slice(0, 300)}`);

    const { rows } = await getPool().query(
      `SELECT workspace_id FROM effects WHERE id = $1`, [effectId]);
    assert.equal(rows[0].workspace_id, ws.workspaceId);
    assert.notEqual(rows[0].workspace_id, other.workspaceId);
  });
});

describe('OAuth — an operator can see and stop a grant', () => {
  test('the grant appears as a revocable key in the workspace', async () => {
    const f = await fullFlow();
    const { rows } = await getPool().query<{ id: string; name: string }>(
      `SELECT k.id, k.name FROM api_keys k
        JOIN oauth_tokens t ON t.api_key_id = k.id
       WHERE t.client_id = $1 LIMIT 1`, [f.client.client_id]);
    assert.ok(rows[0], 'the grant is invisible to the operator');
    assert.match(rows[0].name, /^OAuth · /);
  });

  test('revoking that key kills the OAuth token', async () => {
    const f = await fullFlow();
    const ok = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${f.tokens.access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_get_usage', arguments: {} } } });
    assert.ok(ok.json().result, 'token should work before revocation');

    await getPool().query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = (
         SELECT api_key_id FROM oauth_tokens WHERE client_id = $1 LIMIT 1)`,
      [f.client.client_id]);

    const after = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${f.tokens.access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_get_usage', arguments: {} } } });
    assert.equal(after.statusCode, 401, 'revoking the key must stop the OAuth grant');
  });
});

describe('OAuth — choosing a workspace', () => {
  /** Two workspaces under one email, which is what makes the picker necessary. */
  async function twoWorkspaces() {
    const a = await freshWorkspace();
    const email = (await getPool().query<{ owner_email: string }>(
      `SELECT owner_email FROM workspaces WHERE id = $1`, [a.workspaceId])).rows[0]!.owner_email;
    const b = await freshWorkspace();
    await getPool().query(`UPDATE workspaces SET owner_email = $1 WHERE id = $2`,
      [email, b.workspaceId]);
    return { a, b, email };
  }

  test('the consent page offers every workspace the identity owns', async () => {
    const { a, b } = await twoWorkspaces();
    const { body: client } = await register();
    const first = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: pkce().challenge, code_challenge_method: 'S256',
        api_key: a.key.plaintext }) });
    assert.equal(first.statusCode, 200);
    assert.match(first.body, /Which workspace\?/, 'no picker was offered');
    assert.match(first.body, new RegExp(a.workspaceId));
    assert.match(first.body, new RegExp(b.workspaceId), 'the sibling workspace is missing');
  });

  test('picking a sibling workspace grants against THAT workspace', async () => {
    const { a, b } = await twoWorkspaces();
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256',
        api_key: a.key.plaintext, workspace_id: b.workspaceId, decision: 'allow' }) });
    assert.equal(consent.statusCode, 302);
    const code = new URL(consent.headers.location as string).searchParams.get('code')!;

    const tok = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        code_verifier: verifier, client_id: client.client_id }) });
    assert.equal(tok.statusCode, 200);

    // The token must reach b, not the workspace whose key was pasted.
    const r = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${tok.json().access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ratchet_begin_effect', arguments: {
          effect_type: 'email.send', idempotency_key: `pick-${Date.now()}`, payload: {} } } } });
    const effectId = r.json().result?.structuredContent?.effect_id;
    assert.ok(effectId, `expected a gated effect, got ${r.body.slice(0, 200)}`);
    const { rows } = await getPool().query(
      `SELECT workspace_id FROM effects WHERE id = $1`, [effectId]);
    assert.equal(rows[0].workspace_id, b.workspaceId);
  });

  test('a workspace the identity does NOT own is refused', async () => {
    const mine = await freshWorkspace();
    const someoneElse = await freshWorkspace();       // different owner_email
    const { body: client } = await register();

    const r = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: pkce().challenge, code_challenge_method: 'S256',
        api_key: mine.key.plaintext, workspace_id: someoneElse.workspaceId, decision: 'allow' }) });

    assert.equal(r.statusCode, 403, 'a foreign workspace id was accepted');
    assert.equal(r.headers.location, undefined, 'no code may be issued');
    assert.doesNotMatch(r.body, /[?&]code=/);
  });

  test('a suspended workspace cannot be authorised', async () => {
    const { a, b } = await twoWorkspaces();
    await getPool().query(`UPDATE workspaces SET status = 'suspended' WHERE id = $1`,
      [b.workspaceId]);
    const { body: client } = await register();
    const r = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: pkce().challenge, code_challenge_method: 'S256',
        api_key: a.key.plaintext, workspace_id: b.workspaceId, decision: 'allow' }) });
    assert.equal(r.statusCode, 403);
    assert.match(r.body, /suspended/);
  });

  test('signing in through OAuth records a real identity, not a placeholder', async () => {
    const ws2 = await freshWorkspace();
    const { body: client } = await register();
    const r = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: FORM,
      payload: form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
        code_challenge: pkce().challenge, code_challenge_method: 'S256',
        api_key: ws2.key.plaintext }) });
    const cookie = String(r.headers['set-cookie'] ?? '');
    assert.match(cookie, /rk_session=/);
    const { rows } = await getPool().query<{ email: string }>(
      `SELECT email FROM console_sessions WHERE workspace_id = $1
        ORDER BY expires_at DESC LIMIT 1`, [ws2.workspaceId]);
    assert.notEqual(rows[0]!.email, 'oauth', 'session identity is a placeholder');
    assert.match(rows[0]!.email, /@/);
  });
});

describe('OAuth — hostile input', () => {
  test('a client name cannot inject script into the consent page', async () => {
    const { body: client } = await register({
      client_name: '<script>alert(1)</script><img src=x onerror=alert(2)>' });
    const r = await app.inject({ method: 'GET', url: '/oauth/authorize?' + form({
      response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
      code_challenge: pkce().challenge, code_challenge_method: 'S256' }) });
    assert.equal(r.statusCode, 200);
    // The name must appear as text, never as markup.
    assert.doesNotMatch(r.body, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(r.body, /<img src=x onerror/);
    assert.match(r.body, /&lt;script&gt;/);
  });

  test('a repeated parameter is rejected, not silently last-wins', async () => {
    const r = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: 'grant_type=refresh_token&redirect_uri=https://a.example&redirect_uri=https://b.example' });
    assert.equal(r.statusCode, 400);
    assert.match(JSON.stringify(r.json()), /more than once/);
  });

  test('the protected-resource document points at this server', async () => {
    for (const url of ['/.well-known/oauth-protected-resource',
                       '/.well-known/oauth-protected-resource/mcp']) {
      const m = (await app.inject({ method: 'GET', url })).json();
      assert.match(m.resource, /\/mcp$/);
      assert.ok(m.authorization_servers.length === 1);
    }
  });
});
