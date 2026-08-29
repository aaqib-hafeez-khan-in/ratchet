# Validation report

Everything below was run on this machine against real Postgres 16. No number is estimated.

**Environment:** darwin/arm64 · Node v25.9.0 · Postgres 16-alpine (Docker) · 2026-08-29.

---

## Test suite

`npm test` — recreates the `ratchet_test` database, then runs typecheck, unit, integration, e2e.

| Layer | Suites | Tests | Passed | Failed | Duration |
|---|---|---|---|---|---|
| TypeScript (strict, `noUncheckedIndexedAccess`) | — | — | clean | 0 errors | — |
| Unit | 6 | 25 | 25 | 0 | 0.10 s |
| Integration (real Postgres) | 18 | 73 | 73 | 0 | 1.3 s |
| End-to-end (real HTTP + MCP) | 16 | 54 | 54 | 0 | 1.7 s |
| **Total** | **40** | **152** | **152** | **0** | **~3.1 s** |

No coverage tool is configured, so **no coverage percentage is claimed.** What is claimed is the
list below: each item corresponds to named, passing tests.

### Core state machine
Single-winner leasing · duplicate replay (repeatedly, with the recorded result) · fingerprint
mismatch rejection · key-order-independent fingerprints · clean-failure retry · attempt ceiling
then denial · every non-`execute` decision withholding the lease.

### The indeterminate path
Expired lease → `indeterminate` → `blocked` under the default policy · `retry` policy granting a
fresh attempt with an incremented fencing token · `probe` policy blocking until an explicit
resolve, then returning `duplicate` with the resolved result · worker reaper producing the same
transition as the inline path, and releasing the budget reservation.

### Lease fencing
A superseded token is rejected with `lease_lost` while the current holder still reports normally,
and the newer result is the one stored · a double report is rejected.

### Approval and cancellation
`require_approval` withholds the lease until an operator decides · rejection denies permanently ·
`deny` never grants a lease · a leased effect cannot be cancelled out from under its holder · a
succeeded effect cannot be cancelled · an indeterminate effect can be cancelled and stays denied.

### Concurrency — 25 and 20 callers, real parallelism
25 simultaneous callers on one key → **exactly one `execute`**, 24 `in_flight`, zero stray leases,
one effect row, one metered unit · 10 distinct keys proceed fully in parallel · 20 concurrent
reservations against a budget sized for 5 admit **exactly 5**, with recorded spend landing exactly
on the ceiling and every other call refused with `budget_exceeded`.

### Tenant isolation
The same idempotency key in two workspaces is two independent effects · workspace B cannot read,
list, look up, report on, cancel, or resolve workspace A's effects — and a *genuine* lease token
from the other workspace is still rejected with `not_found`, never a hint the record exists ·
policies and budgets do not cross.

### Authentication and scopes
Malformed, truncated, and forged keys rejected · revocation immediate · suspended workspace
refused · no plaintext secret recoverable from `api_keys` · scopes enforced and non-wideable ·
scope failures name the missing scope.

### Billing and the ledger
Only newly created effects are metered · repeat calls never metered · included usage draws no
credit · overage draws exactly the plan rate and writes exactly one immutable ledger row · an
exhausted balance refuses new effects **and leaves no partial row** · an exhausted balance still
permits duplicate suppression · monthly period rollover · top-ups idempotent on dedupe key · eight
concurrent replays of one payment event credit exactly once · the ledger sums to the balance ·
test-mode settlement idempotent · purchased credit is actually spendable · a plan upgrade raises
the allowance.

### Webhooks
A receiver reproduces the signature exactly · tampering fails verification · one logical event is
never delivered twice to an endpoint · 4xx dead-letters immediately without retry · 5xx re-queues
with a future `next_attempt_at` · a redirect is refused, not followed · only subscribed event
types are delivered · unreachable destinations record the reason and retry.

### SSRF (delivery time, production configuration)
Refused **without contacting**, verified by asserting `last_status` is null: cloud metadata
(`169.254.169.254`), loopback, RFC1918 class A/B/C, IPv6 loopback,
`metadata.google.internal`, and plain http to a public host. Address classification tested at
range boundaries (`172.15.255.255` public / `172.16.0.0` private / `172.32.0.0` public) and for
IPv4-mapped IPv6 forms.

### HTTP surface
Full onboarding → gate → execute → report → replay → free lookup → filtered list · unauthenticated
calls refused · scoped keys constrained · revoked keys stop working · listings never disclose
secrets · seven malformed-body cases rejected including unknown fields · oversized results refused
with actionable guidance · **errors carry no stack traces, SQL, or connection strings** (asserted
by pattern-matching response bodies) · security headers present · `Cache-Control: no-store` on
`/v1` · CORS refuses credentials to an arbitrary origin · session cookie `HttpOnly` + `SameSite`.

### Rate limiting
Enforced per key · machine-readable 429 with `retry_after_seconds` · one tenant cannot throttle
another · signup limited separately and more tightly · oversized bodies refused.

### MCP — both transports
`initialize` negotiating current and older protocol versions · instructions shipped to the model ·
`tools/list` matching the published definitions, every tool carrying a schema and an actionable
description · **manifest, `/mcp/info`, and `tools/list` asserted identical**, so they cannot drift ·
notifications answered `202` with no body · unknown methods returning `-32601` · JSON-RPC batches
with notifications correctly omitted · unauthenticated calls refused with `WWW-Authenticate` ·
scopes enforced per tool · full core loop with `next_step` guidance · every non-`execute` decision
beginning with `STOP` · `check_effect` never granting a lease · resolve restoring normal semantics ·
tool failures returned as readable results rather than protocol errors · **stdio transport tested
by spawning a real child process** and completing a handshake plus a tool call.

---

## Defects found by these tests and fixed

Five real bugs, all found by tests rather than by reading:

1. **Deadlock between the effects foreign key and metering.** `INSERT INTO effects` takes a
   `KEY SHARE` lock on the parent `workspaces` row; metering later needs it exclusively. Two
   concurrent creations deadlocked. Fixed with a global lock order and an unlocked pre-check that
   keeps the lock off the duplicate path.
2. **Budget ceilings could be overshot on the first spend of a day.** `SELECT ... FOR UPDATE`
   locks nothing when the row is absent, so twenty concurrent callers all read `0` and all passed.
   Fixed by materialising the row before locking, and validating all scopes before incrementing
   any.
3. **Every rate-limited request returned `500` instead of `429`.** `@fastify/rate-limit` passes
   its `errorResponseBuilder` result to the error handler *as the error*; a plain object arrived
   with no status. Clients would have retried a "server error" that was actually a limit.
4. **Concurrent migrations crashed on boot.** `CREATE TABLE IF NOT EXISTS` is not safe against a
   concurrent identical create; two instances starting together raced in the system catalog. Fixed
   by taking the advisory lock first.
5. **Unknown request fields were silently dropped.** Fastify's default `removeAdditional` meant a
   caller writing `estimated_cost` instead of `estimated_cost_micros` would lose budget
   enforcement with no error. Now rejected.

A sixth issue surfaced in the browser rather than in a test: the strict CSP (`script-src 'self'`)
blocked inline page scripts. They were moved to external modules rather than weakening the policy.

---

## Measured latency

`npx tsx scripts/bench.ts 500` — in-process HTTP injection against local Postgres, excluding
network round-trip. 50 warm-up calls discarded.

```
begin (new effect)         n=500  mean=2.14ms  p50=2.08  p95=2.39  p99=2.94  max=6.59
begin (duplicate replay)   n=500  mean=1.58ms  p50=1.56  p95=1.75  p99=2.13  max=3.22
report outcome             n=500  mean=1.38ms  p50=1.35  p95=1.58  p99=2.27  max=2.70

200 concurrent callers on ONE key:       107ms total
200 concurrent callers on DISTINCT keys: 251ms total
```

`npx tsx scripts/bench-budget.ts` — with a daily budget configured, so reservation runs:

```
begin (new, budget enforced)  n=400  mean=3.41ms  p50=3.36  p95=3.64  p99=4.27
```

Budget enforcement adds roughly 1.3 ms, because reserving spend locks and reads three scope rows
before validating any of them — the cost of the guarantee that concurrent callers cannot
collectively exceed a ceiling.

**No service-level objective is claimed.** These are single-machine, in-process numbers with no
network hop, no TLS, and no managed-database latency. They establish that the synchronous path is
a handful of indexed statements, not that a deployed instance will hit any particular percentile.

---

## Production build verification

Against the compiled `dist/` output, `NODE_ENV=production`:

- `readyz` → `{"status":"ready","database":{"ok":true,"latency_ms":0.8}}`
- Signup → key issued with the `rk_live_` prefix (test builds issue `rk_test_`)
- Core loop → first call `execute`, second call `in_flight`
- Headers → `strict-transport-security`, `x-frame-options: DENY`, `x-content-type-options: nosniff`,
  `cache-control: no-store`
- Startup guard → with `AUTH_SECRET` left at the development default the process **refuses to
  start** and names the reason

## Manual verification in a real browser

Driven through the in-app browser against a live instance:

- Landing, docs, pricing, security, and console pages all return 200 and render
- Signup form → workspace created, key shown once with a runnable snippet
- Console → live plan, allowance, credit, and today's external spend
- Alert strip correctly surfaced one unknown outcome and one pending approval
- **Resolve flow exercised end to end**: clicking "It happened" with evidence moved the effect from
  `indeterminate` to `succeeded`, cleared the alert, and dropped the indeterminate count to zero
- Layout audited programmatically at 1280px and 375px: no horizontal overflow at either width;
  wide code and tables scroll inside their own containers; the header collapses correctly on mobile

## The full walkthrough

`bash examples/curl/walkthrough.sh` runs nine steps against a live instance and was executed
successfully: signup, gate, in-flight refusal, report, replay, key-reuse rejection, simulated
crash, `blocked` with `prior_attempt` evidence, resolve with evidence, and a final `duplicate`
carrying the resolved result.

---

## Dependency audit

```
npm audit --omit=dev  →  found 0 vulnerabilities
```

Nine production dependencies, exact-pinned, with a lockfile. `undici` was added for webhook
delivery, flagged by audit with thirteen advisories, and removed in favour of Node's built-in HTTP
client — which also removes redirect-following risk and enables socket pinning.
`@modelcontextprotocol/sdk` and `zod` were installed during development and removed once it was
clear nothing used them.

---

## What was not validated

- **No live payment provider was exercised.** Signature verification, event deduplication, the
  ledger, and entitlement are tested; the outbound checkout call is not implemented.
- **No load test at production scale.** The concurrency tests prove correctness under contention,
  not throughput at volume.
- **No deployment to a hosting provider.** No credentials were available. The build is verified,
  containerised, and compose-runnable locally.
- **No multi-instance run.** The design supports it (`SKIP LOCKED`, advisory-locked migrations),
  and migration races are now tested, but two API instances plus two workers were not run
  simultaneously against one database.
- **No third-party security audit.**
