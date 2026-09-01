# OAuth 2.1 for MCP — 2026-08-30

Built so an MCP client or a connector directory can obtain access without a human copying an API
key into a config file. Anthropic's connector directory requires remote MCP with OAuth and
Dynamic Client Registration; API-key auth alone does not qualify.

## Shape

Authorization code with PKCE, plus refresh. Nothing else. No implicit grant, no password grant,
no `plain` challenge method — OAuth 2.1 removes all three because they are the ones that get
exploited, and advertising any of them would invite their use.

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728. What `/mcp` points a 401 at. |
| `/.well-known/oauth-authorization-server` | RFC 8414. Where the endpoints are. |
| `POST /oauth/register` | RFC 7591 dynamic registration. Unauthenticated. |
| `GET\|POST /oauth/authorize` | Consent. Requires a signed-in human. |
| `POST /oauth/token` | `authorization_code` and `refresh_token`. |
| `POST /oauth/revoke` | RFC 7009. Always 200. |

`/mcp` answers an unauthenticated request with
`WWW-Authenticate: Bearer realm="ratchet", resource_metadata="…"`, which is the entire mechanism
by which a client that has never seen this server can start a flow on its own.

## The properties that matter, and where they are enforced

**Audience binding.** A token records the resource it was minted for and is refused anywhere
else (`authenticateOAuth`). Without this, a client holding a token for one server can replay it
against another that trusts the same issuer — the confused deputy the MCP spec names directly.

**Single-use codes.** Replaying a code does not merely fail: it revokes every token descended
from it. A replay means the code leaked, so its descendants can no longer be trusted. The
consume is an `UPDATE … WHERE consumed_at IS NULL`, so two concurrent redemptions cannot both
win — the database decides, not a read-then-write.

**No open redirect.** The client and the redirect URI are validated *before* anything else, and
an error is only ever redirected to a URI genuinely registered to that client. An unregistered
URI gets a 400 page that does not reflect it.

**Redirect URI rules.** Exact match. HTTPS, or loopback HTTP (RFC 8252, which is what native MCP
clients need), or a private-use scheme. `javascript:`, `data:`, `file:`, and `vbscript:` are
refused at registration. No fragments.

**Escaping.** Registration is unauthenticated, so `client_name` is attacker-controlled and
renders into the consent page. It is escaped, and a test asserts a script tag cannot survive.

**Parameter pollution.** The form parser rejects any repeated parameter rather than keeping the
last. RFC 6749 §3.1 forbids repetition, and a last-wins parser lets an attacker smuggle a second
`redirect_uri` past whatever validated the first.

**CSRF.** The session cookie is `SameSite=Lax`, so a cross-site POST does not carry it. The
Origin header is checked as well.

**Storage.** Codes are stored as SHA-256 digests, tokens as HMAC digests under `AUTH_SECRET`,
compared in constant time and always compared even for an unknown prefix. No bearer value is ever
stored in the clear.

**Production.** `assertProductionSafety()` now refuses to start if `PUBLIC_URL` is not HTTPS. It
is the OAuth issuer and every endpoint a client discovers derives from it; over plaintext the
authorization code is exposed in transit and the flow is worthless.

## Grants are backed by a real API key

The first implementation returned the OAuth token's own id as `AuthContext.keyId`. Every gated
call from an OAuth client then died with an internal error, because `effects.leased_by_key_id`
has a foreign key to `api_keys(id)`. A test caught it.

The fix turned out to be worth more than the bug cost: a grant now creates a real `api_keys` row
(`OAuth · <client name>`), and the token carries `api_key_id`. The foreign key holds, and the
existing machinery works for OAuth clients with no special cases — per-key budgets, attribution
in the audit trail, and **revocation from the console**, which is the surface an operator will
actually reach for. Revoking that key kills the grant; both are tested. The generated plaintext
is discarded and never shown to anyone.

## Lifetimes and cleanup

Access 1 hour, refresh 30 days and rotated on every use (the presented token is revoked as the
new pair is minted), codes 60 seconds and single-use.

The worker sweeps spent codes after a day, expired and revoked tokens after 30 days, and
client rows that no human ever approved after a day. That GC is what lets registration carry a
generous rate limit (100/hour per IP): it grants nothing on its own, so the limit only has to
bound table growth, and a shared corporate egress IP legitimately registers many clients.

## Choosing a workspace

`owner_email` is indexed but deliberately not unique — one person may run a staging workspace and
a production one — so the consent screen asks which one the client is being let into rather than
assuming. With one workspace it names it and moves on; with several it offers a radio group,
pre-selecting the session's own workspace. Suspended workspaces are never offered.

The security of this rests on one check. The workspace id arrives from a form field the user
controls, so `workspaceOwnedBy(session.email, id)` re-derives ownership from the database before
a code is issued. Without it, a session for one workspace could mint a token for any other by
editing a radio button — a cross-tenant escalation dressed up as a UI choice. Refused with a 403
and no code, and tested.

The choice is rendered as a control and never also as a hidden field. A hidden copy of
`workspace_id` would be submitted alongside the radio and silently win; a test asserts there is
exactly one pre-selected radio and no hidden duplicate.

This also fixed a bug in the first version: sessions created during the OAuth sign-in stored the
literal string `'oauth'` as their email instead of the workspace's owner. That left the session
with no real identity, which the picker resolves against — so it would have found nothing. Now it
records the owning address, asserted by test.

## Not done

- **No `client_secret` rotation** and no registration access token (RFC 7592 management API).
- **Not yet submitted to any directory.** That still needs the npm package published and a
  public repository.

---

## Discovery without a credential — 1 September 2026

`initialize`, `ping`, `notifications/*` and `tools/list` no longer require a
credential. `tools/call` still does, and still answers 401 with the
`WWW-Authenticate` challenge, because that header is the entire mechanism by
which a client that has never seen this server discovers where to start an OAuth
flow.

**Why it changed.** MCP clients connect first and configure second: they call
`initialize` and `tools/list` before the user has pasted anything. Refusing
those meant the client reported *"connection closed"* and the user never learned
that a key was the missing piece. Glama, indexing the server, hit the same wall
and graded tool quality as unrated because it could never read the definitions.

**Why it is safe.** None of those methods reads `ctx` — they return identical
bytes for every caller. The tool definitions live in `src/mcp/tools.ts` in a
public repository and are described on the website; withholding them protected
nothing. `handleRpc` now takes `AuthContext | null` and `tools/call` fails
closed if it is ever reached without one, so the HTTP layer is not the only
thing standing between an anonymous caller and a tool.

An anonymous caller is given no `Mcp-Session-Id`, since there is no workspace to
name. A batch containing any private method is refused as a whole.

## The bridge no longer exits without a key

`packages/ratchet-mcp` used to `process.exit(1)` when `RATCHET_API_KEY` was
unset. That turned a configuration problem into a dead process, which every
client reports as a connection failure. It now starts, serves discovery, and
returns a JSON-RPC error naming the variable on the first `tools/call`. It also
omits the `authorization` header entirely when there is no key, rather than
sending `Bearer undefined` — which the server must reject, turning "no key" into
"bad key" and sending whoever is debugging down the wrong path.

## packages/ratchet-mcp/Dockerfile

The root `Dockerfile` builds the Ratchet *service* and its CMD starts an HTTP
API. A directory that builds it, hands it a stdio proxy and waits for MCP gets
"connection closed" — which is exactly what happened. The new Dockerfile beside
the package builds the bridge alone: one file, no dependencies, no install step,
non-root.
