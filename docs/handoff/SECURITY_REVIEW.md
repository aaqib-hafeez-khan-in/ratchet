# Security review

Scope: this repository as it stands. Every control listed as implemented has a test; where a
control is partial or absent, it says so.

**No third-party audit has been performed.** There is no SOC 2 report, no penetration test, and no
compliance certification. Implemented-and-tested is a real claim; independently-verified is a
different and larger one, and is not made here.

---

## Design posture

The strongest control is architectural: **Ratchet does not perform side effects.** It accepts no
code, no shell commands, and no URLs to fetch on a caller's behalf. It holds no vendor credentials
and has no inbound path to customer systems. A full compromise of this service yields payload
hashes, effect state, and hashed keys — not the ability to act on anyone's behalf.

The second is data minimisation. Only `sha256(canonicalize(payload))` is stored, never the payload.
Ratchet can tell that a key was reused with different arguments — a real class of bug — while being
unable to reconstruct those arguments.

---

## Threat model

### T1 — Stolen API key
**Mitigations.** Scopes limit blast radius (a gating agent holds only `effects:begin` and
`effects:report`, and cannot read results, change policy, or resolve). Per-key daily spend ceilings
cap damage. Revocation is immediate. Per-key rate limits bound throughput. All key actions are
audited with the key prefix.
**Residual.** A stolen `effects:begin` key can consume a workspace's allowance. Watch the console;
revoke and rotate. *Tested:* scope enforcement, immediate revocation, per-key limits.

### T2 — Database exfiltration
**Mitigations.** Keys are stored as `HMAC-SHA256(secret, AUTH_SECRET)` — the pepper lives in the
environment, so the dump alone yields no usable key. Payloads are absent by construction. Console
session cookies are stored hashed.
**Residual.** Recorded `result` values and `request_summary` are readable; they contain whatever
the caller chose to record. Documented as caller-controlled, with the guidance to store references
rather than sensitive content. *Tested:* no plaintext secret is recoverable from `api_keys`.

### T3 — Cross-tenant access
**Mitigations.** Every query is workspace-scoped; there is no unscoped read path. A cross-tenant
lookup returns `404`, never a hint the record exists elsewhere. A genuine lease token from another
workspace is still rejected. The same idempotency key in two workspaces is two independent effects.
*Tested:* read, report, cancel, resolve, list, lookup, and policy isolation.

### T4 — SSRF via webhooks
**Mitigations.** Two independent layers. At registration: https only, DNS hostnames only (IP
literals refused), ports 80/443, no embedded credentials, optional host allowlist. At **every**
delivery attempt: DNS re-resolved and the socket **pinned** to the address just validated, closing
the rebinding window between check and connect. A host resolving to *any* private address is
refused outright rather than filtered. Blocked ranges cover loopback, RFC1918, link-local
(including `169.254.169.254`), CGNAT, benchmarking, multicast, reserved, IPv6 loopback and ULA,
and IPv4-mapped forms. Redirects are never followed. Response bodies are capped and discarded.
*Tested:* range classification with boundary cases; delivery-time refusal of metadata, loopback,
RFC1918, IPv6 loopback, and `metadata.google.internal`, asserting `last_status` is null so no
request was made at all.

### T5 — Prompt injection through agent-supplied content
**Mitigations.** Nothing Ratchet stores is ever interpreted as an instruction. Decisions come from
stored policy and database state only. `effect_type` is pattern-constrained; results are
size-capped; unknown fields are rejected. There is no path by which payload content can widen a
key's scopes, raise a budget, change a policy, or alter a decision.
**Residual.** A malicious payload can influence what an *operator* reads in the console. Console
rendering escapes all interpolated values.

### T6 — Replay and duplicate execution
**Mitigations.** A database unique constraint enforces at-most-once; there is no application-level
check-then-act. Fencing tokens stop a stalled worker overwriting a newer attempt. Payload
fingerprints catch key reuse. `indeterminate` refuses to guess.
*Tested:* 25-way race admits exactly one; stale token rejected; double-report rejected.

### T7 — Webhook forgery
**Mitigations.** HMAC-SHA256 over `timestamp.delivery_id.body`. Including the delivery id means a
captured delivery cannot be replayed under a different id. Secrets are per-endpoint and returned
once. *Tested:* receiver-side verification reproduces the signature; tampering fails.

### T8 — Payment webhook forgery or replay
**Mitigations.** Signature verified over the **raw** body (captured in `preParsing` only for that
route, since verifying against a re-serialized body is unsound), constant-time comparison, 300s
replay window, and provider event-id deduplication in `processed_payment_events`.
*Tested:* valid, tampered, wrong-secret, stale-timestamp, malformed-header, and no-secret cases;
concurrent replays credit exactly once.

### T9 — Billing abuse
**Mitigations.** Only newly created effects are metered, so a race cannot be billed N times.
Overage is prepaid, so a runaway agent hits a wall rather than an invoice. Ledger entries are
deduplicated on the effect id. Client-supplied prices, plans, and balances are never trusted.
*Tested:* race meters once; refused effect leaves no row; ledger sums to the balance.

### T10 — Resource exhaustion
**Mitigations.** Per-key rate limiting (not per-IP, so tenants cannot exhaust each other).
Signup is separately and more tightly limited. Body and result size caps. `statement_timeout` and
`idle_in_transaction_session_timeout` on every connection. Bounded worker batches. Retention GC.
**Residual.** The rate-limit store is per-process in-memory, so limits are per-instance rather than
global. See KNOWN_LIMITATIONS. *Tested:* limits enforced, tenants independent, oversized bodies
refused.

### T11 — Supply chain
**Mitigations.** Nine production dependencies, all exact-pinned, with a lockfile.
`npm audit --omit=dev` reports **zero vulnerabilities**. `undici` was removed after audit flagged
it, in favour of Node's built-in client — which also removed redirect-following risk.

### T12 — Unsafe deployment
**Mitigations.** `assertProductionSafety()` **refuses to start** in production when `AUTH_SECRET`
is the development default or under 32 characters, `CORS_ORIGINS` contains `*`, or
`WEBHOOK_ALLOW_PRIVATE_NETWORK` is enabled. *Verified manually against the compiled build.*

---

## Transport and application controls

| Control | Status |
|---|---|
| `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` | Implemented, tested |
| HSTS in production | Implemented, verified against the compiled build |
| CSP on HTML: `script-src 'self'`, no `unsafe-inline`, `frame-ancestors 'none'` | Implemented and **enforced** — it blocked inline page scripts until they were externalised |
| `Cache-Control: no-store` on `/v1` | Implemented, tested — per-key responses must not reach a shared cache |
| CORS same-origin by default; credentials never granted to a wildcard | Implemented, tested |
| Session cookie `HttpOnly`, `SameSite=Lax`, `Secure` in production | Implemented, tested |
| CSRF | Addressed structurally: `begin`/`report` are key-only; `SameSite=Lax` blocks cross-site POSTs on session routes |
| Strict body validation (unknown fields rejected) | Implemented, tested |
| Log redaction of `authorization`, `x-api-key`, `cookie`, `stripe-signature`, `set-cookie` | Implemented |
| Safe errors — no stack traces, SQL, or connection strings | Implemented, tested by pattern-matching responses |
| Constant-time key comparison, run even for unknown prefixes | Implemented |
| Audit trail for keys, policies, approvals, resolutions, webhooks, lease expiries | Implemented |

---

## Retention and deletion

Effect records carry `expires_at` from their policy's `retention_days` (bounded by plan). The
worker deletes expired records, and never touches `pending` rows, so a live lease cannot vanish.
Console sessions are deleted at expiry; delivered and dead webhook records after 30 days.
Deleting a workspace cascades to keys, effects, policies, ledger, webhooks, sessions, and audit.

---

## Known gaps

| Gap | Impact | Path |
|---|---|---|
| Rate limits are per-process | An N-instance deployment permits ~N× the configured rate | Move `@fastify/rate-limit` to a Redis store |
| No third-party audit | Unverified by an independent party | Engage one before making any compliance claim |
| No automated dependency-update pipeline | Advisories are caught only when `npm run audit` is run | Add Dependabot or Renovate plus audit in CI |
| Recorded `result` values are not encrypted at rest | A database compromise exposes what callers chose to record | Rely on storage-level encryption; document that references beat payloads |
| No per-workspace encryption keys | Same | Out of scope at this stage |
| Console has no second factor | A stolen session cookie grants operator access for its TTL | Add SSO or WebAuthn before multi-operator use |
| Live payment path not enabled | Cannot take real payments | See KNOWN_LIMITATIONS |
