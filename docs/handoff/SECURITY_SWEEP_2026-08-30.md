# Adversarial security sweep — deployed instance

**Target:** `https://ratchet-gate.fly.dev` (production) · **Date:** 2026-08-30
**Method:** live probing of the running service, plus source and git-history review.
Not a substitute for a third-party audit; no independent review has been performed.

## Result: no leak and no unauthorised access found

### Secret exposure — clean
Eleven public surfaces (landing, docs, pricing, security, console, OpenAPI, `llms.txt`, manifest,
`/mcp/info`, health, readiness) scanned for Stripe keys, webhook secrets, API keys, connection
strings, `AUTH_SECRET`, and private-key blocks. **Zero matches.**

Path traversal and common config-file probes (`/.env`, `/.git/config`, `/package.json`,
`/dist/api/server.js`, encoded traversal) all return 404 — the static handler exposes only `web/`.

### Error handling — clean
Malformed bodies, oversized fields, and wrong types return `invalid_request` with no stack traces,
SQL, file paths, or connection strings.

### Cross-tenant isolation — clean
Workspace B was given workspace A's real effect id **and A's real lease token**:

| Attempt | Result |
|---|---|
| Read A's effect by id | `404` |
| Look up A's idempotency key | `404` |
| Report on A's lease with A's genuine token | `404` |
| Cancel / resolve A's effect | `404` |
| List effects, audit trail | A's records absent |

`404` rather than `403` throughout, so the response never confirms the record exists elsewhere.
A's raw payload appears in **zero** API responses — only the fingerprint is stored.

### Authentication — clean
No-auth, empty bearer, malformed key, valid-prefix-forged-secret, truncated key, SQL in the key,
null byte in the key, and a forged console cookie all return `401`. A wrong secret for a **real**
prefix and a wrong secret for a **fake** prefix both return `401` — no existence oracle.

### Injection — clean
`'; DROP TABLE effects; --`, `' OR 1=1 --`, and `1;SELECT pg_sleep(5)--` submitted through
`effect_type`, `idempotency_key`, `payload`, and `agent_id`. All stored as literal data; the table
survived. Everything is parameterised — there is no string-built SQL in the codebase.

### Network exposure — clean
`nc -z ratchet-gate.fly.dev 5432` *appears* to succeed. It does not: a real Postgres protocol
handshake gets `connection reset`, because Fly's edge proxy accepts TCP on any port before routing
and then drops it when nothing is bound. `ratchet-gate-pg.fly.dev` does not resolve at all — the
database has no public hostname and is reachable only over private flycast. **A TCP accept at an
edge proxy is not an exposed service, and the distinction is worth testing rather than assuming.**

### SSRF — clean
Eleven hostile webhook destinations refused at registration: cloud metadata
(`169.254.169.254`, `metadata.google.internal`), loopback, RFC1918 ranges, IPv6 loopback,
embedded credentials, non-web ports, plain http, `file://`, and **Fly's own internal flycast
address** — the one that would have reached the database.

### Rate limiting — enforced
135 requests against a free-plan key: 109 accepted, 26 throttled, consistent with the published
120/min against a partially-consumed window.

### Privilege and billing escalation — all refused

| Attempt | Result |
|---|---|
| Self-assign `plan` / `credit_micros` at signup | `400`; workspace created as `free` |
| Grant a key an undefined scope | `400` |
| Mint credit via the test adapter while Stripe is live | `forbidden` |
| Forge a payment webhook with no signature | `400` |
| Negative `estimated_cost_micros` to game budgets | `invalid_request` |
| Retention beyond the plan cap | `forbidden` |
| Exceed the free API-key cap | `201 201 403 403 403` |

### Git history — clean
Every blob across all commits scanned for the **actual** secrets used in this session (Stripe key,
Fly token, both database passwords). **None present.** One regex hit was the literal placeholder
`postgres://user:password@host` in an example config. `.env` is gitignored and untracked.

### Dependencies — clean
`npm audit --omit=dev`: **0 vulnerabilities**, 9 production dependencies. The published
`ratchet-mcp` package has **zero** dependencies and carries no database access or server secret.

## Residual risks — unchanged and still true

| Risk | Status |
|---|---|
| No third-party audit | Outstanding. Implemented-and-tested ≠ independently verified |
| Signup has no email verification, `owner_email` is not `UNIQUE` | One address can mint workspaces at the signup rate limit. Cheap (~$200/mo at 25,000 free workspaces at cap) but unbounded in principle |
| Console has no second factor | A stolen session cookie grants operator access for its TTL |
| Rate-limit store is per-process | An N-instance deployment permits ~N× the configured rate. Currently one instance |
| Database backups are the operator's responsibility | Consequence of the unmanaged-Postgres cost decision |
| Recorded `result` values are not encrypted at rest | Callers control what they record; the guidance is to store references, not content |
