# Decision log

Each entry: what was decided, why, what was rejected, and what would change it.

---

## D1 — The product is an effect gate, not a job queue

**Decided.** Agents call Ratchet *before* performing a side effect and obey the returned decision.
Ratchet never executes anything.

**Why.** The brief's starting point — submit a job, poll, get billed — is something a competent
operator rebuilds in an afternoon, and it forces the service to run untrusted work. Inverting it
removes the sandbox, the credential vault, the worker fleet, and the outbound access, while
targeting a problem that genuinely has no good answer today: an LLM's control flow is
non-deterministic, so the same logical action gets attempted an unknown number of times, and
nothing in the stack knows which.

**Rejected:**
- *Durable execution engine* (Temporal-shaped). Heavy, requires code to run inside it, and forces a
  rewrite of the agent to adopt.
- *Vendor-specific idempotency proxy.* Only works for vendors that already support it — the ones
  that need help least.
- *Prompt-level guardrails.* Cannot survive a process crash, which is the interesting case.

**Would change it if:** agent frameworks converge on a standard durable-execution substrate that
already carries cross-process idempotency. Then the gate belongs inside it.

---

## D2 — `indeterminate` is a first-class state

**Decided.** A lease that expires unreported does not become `failed`. It becomes `indeterminate`,
and what happens next is the operator's declared policy.

**Why.** This is the whole product. Every system that silently permits a retry after an ambiguous
failure is choosing duplicates over lost work, without telling anyone it made that choice. Ratchet
surfaces the choice, per effect type, once, in advance. `block` is the default because an
unconfigured effect type is one we know nothing about.

**Rejected:** auto-retry with a "probably fine" heuristic. There is no heuristic that distinguishes
"the request never left" from "the response never came back", and guessing wrong is precisely the
double charge the customer bought this to prevent.

---

## D3 — Never claim exactly-once

**Decided.** The guarantee is at-most-once *initiation* plus recorded replay. Documentation, the
landing page, and the manifest all say so explicitly.

**Why.** Exactly-once delivery across a network boundary is not achievable, and every vendor that
claims it is either redefining the term or lying. Since honesty about failure modes *is* the
product, overclaiming here would be self-defeating.

---

## D4 — Postgres, not SQLite

**Decided.** Postgres for all environments, in Docker for local development.

**Why.** Correctness rests on `INSERT ... ON CONFLICT`, `SELECT ... FOR UPDATE`,
`FOR UPDATE SKIP LOCKED`, partial indexes, and advisory locks. SQLite's single-writer model cannot
express the lock ordering this design needs, and multi-instance deployment is a requirement, not a
future nicety.

**Cost accepted:** local development requires Docker. `npm run dev:db` reduces that to one command.

---

## D5 — Lock order `workspaces` → `effects` → `spend_windows`

**Decided.** `beginEffect` takes an exclusive lock on the workspace row before inserting an effect,
but only on the genuinely-new path, gated by an unlocked pre-check.

**Why.** Found by a failing test. The effect's foreign key takes a `KEY SHARE` lock on the
workspace row; metering later needs it exclusively. Two concurrent creations deadlocked. Taking
the exclusive lock first removes the cycle.

The pre-check matters commercially as well as technically: duplicates, in-flight checks, and
retries skip the lock entirely — which is exactly the set of calls that are never billed. The hot
path is both the free path and the fast path (0.22 ms versus 2.11 ms measured).

**Cost accepted:** new-effect creation serialises per workspace. Measured at 200 concurrent
callers in 16–19 ms, so this is not a practical ceiling at this stage. The sharding path is
recorded in KNOWN_LIMITATIONS.

---

## D6 — Budget reservation materialises rows before locking

**Decided.** `reserveSpend` inserts a zero row, locks it, reads it — for every scope, in fixed
order — then validates all, then increments all.

**Why.** Found by a failing test. `SELECT ... FOR UPDATE` locks nothing when the row is absent, so
on the first spend of a day every concurrent caller read `0` and all of them passed. Twenty
callers overshot a budget each of them individually respected.

**Also decided:** a zero-cost reservation short-circuits before any query. Reserving nothing cannot
breach a ceiling, and skipping it removed six queries from the metered path (2.96 ms → 2.11 ms).

---

## D7 — Ratchet's revenue and the customer's spend are separate systems

**Decided.** `ledger_entries` tracks money Ratchet collects. `spend_windows` tracks the customer's
declared spend at third parties, purely to enforce ceilings. They never interact.

**Why.** Conflating them would make Ratchet appear to charge for an agent's Stripe fees. It is also
a correctness matter: one is a balance we owe against, the other is a rolling daily counter.

---

## D8 — Meter unique effects, not API calls

**Decided.** One billable unit: a `begin` that creates a new effect record. Duplicate suppression,
in-flight checks, retries, reports, reads, policy changes, and webhooks are free.

**Why.** Per-call pricing would bill the customer most on the day their agent misbehaves — the day
the product is doing its job. That is a perverse incentive and an obvious objection in a sales
conversation. Metering protected actions aligns price with value, is trivial to explain, and
happens to match our cost curve, since a duplicate check is one indexed read.

**Rejected:** per-seat (agents are not seats), per-workspace flat (no relationship to cost),
per-effect-type (encourages bundling unrelated actions under one type, which breaks policy).

---

## D9 — Prepaid credit, never postpaid

**Decided.** Overage draws from a balance the customer loaded. At zero, new effects are refused
with `402`; existing effects still replay.

**Why.** The customer base is autonomous agents. A runaway loop should hit a wall, not generate an
invoice. It also sidesteps card-processor minimums, which make per-effect charging impossible at
$0.0002 a unit.

**Deliberate detail:** an exhausted balance blocks *new* effects but never duplicate suppression.
Cutting off replay when someone runs out of credit would cause the exact duplicate the product
exists to prevent — a billing state must never create a safety incident.

---

## D10 — Ship the test billing adapter, not a half-wired Stripe integration

**Decided.** `BILLING_PROVIDER=test` performs no network I/O and issues no charge. Signature
verification, event idempotency, the ledger, and entitlement are fully implemented and tested. The
live checkout call is explicitly not enabled and says so.

**Why.** No payment credentials were available. Writing an untested live call and calling it
production-ready is exactly the false claim the brief prohibits. Every response carries
`test_mode: true`, and the pricing page states it in plain language.

**What is genuinely done:** webhook signature verification with a replay window (tested against
tampering, wrong secrets, and stale timestamps), event-id deduplication, the append-only ledger,
concurrent-replay safety, and plan entitlement.

---

## D11 — No arbitrary execution, ever

**Decided.** Ratchet accepts no code, no shell, no URLs to fetch on a caller's behalf. The only
outbound requests are webhooks to endpoints an operator registered.

**Why.** It is the product thesis, not a restriction. Because Ratchet performs nothing, a
compromise yields hashes and state transitions — no credentials, no payloads, no ability to act.

---

## D12 — Two SSRF layers, with socket pinning

**Decided.** Validate at registration; re-resolve DNS and pin the socket at every delivery.

**Why.** Either layer alone is bypassable. Registration-time checks lose to a hostname repointed
afterwards; a delivery-time check that resolves and then connects separately loses to DNS
rebinding in between. Pinning the socket to the address just validated closes that window. A host
resolving to any private address is refused outright rather than filtered, because a
mixed-response host is hostile, not ambiguous.

---

## D13 — Node's built-in HTTP client instead of undici

**Decided.** Dropped `undici` after adding it.

**Why.** The pinned version carried thirteen advisories, `npm audit` flagged it, and Node's own
client does everything needed: it never follows redirects, and its `lookup` hook is what makes
socket pinning possible. Removing it took production vulnerabilities to zero.

---

## D14 — Static HTML, no frontend framework

**Decided.** Five hand-written pages, one stylesheet, ES modules. No build step.

**Why.** The web surface is a landing page, three content pages, and a console that renders a
handful of tables. A framework would add a build pipeline and hundreds of transitive dependencies
to a service whose entire selling point is a small, auditable blast radius.

**Consequence that proved the point:** the strict CSP (`script-src 'self'`, no `unsafe-inline`)
blocked the page scripts until they were moved to external files. The policy caught a real
mistake, which is what a policy is for. It was not weakened to work around itself.

---

## D15 — MCP tool descriptions are part of the contract

**Decided.** Tool descriptions in `src/mcp/tools.ts` are written for an LLM reader, tell the model
what it must *not* do with each answer, and every non-`execute` decision returns a `next_step`
starting with `STOP`.

**Why.** The failure mode is not a client that mishandles JSON. It is a model that reads
`duplicate` and retries anyway. The descriptions are load-bearing, and an e2e test asserts the
stdio transport, the HTTP transport, and the published manifest all expose the same set.

---

## D16 — Strict body validation

**Decided.** Fastify's `removeAdditional` is disabled, so unknown fields are rejected.

**Why.** The default silently strips them. A caller writing `estimated_cost` instead of
`estimated_cost_micros` would lose budget enforcement and never be told — the failure would surface
as a surprise invoice. Rejecting surfaces it on the first call. Found by a test written to check
the opposite assumption.

---

## D17 — `begin` and `report` are key-only

**Decided.** The two agent hot paths accept only an API key. Reads and operator actions accept a
console session cookie or a scoped key.

**Why.** Machine endpoints should not be reachable from a browser session, which also removes them
from CSRF consideration entirely. `SameSite=Lax` protects the session-authenticated POSTs that
remain.

---

## D18 — Rate-limit refusals return a real `ApiError`

**Decided.** `errorResponseBuilder` returns an `ApiError` instance rather than a plain object.

**Why.** Found by a failing test. The plugin hands its builder's return value to the error handler
*as the error*, so a plain object arrived with no `statusCode` and every throttled request returned
`500` instead of `429`. Clients would have retried a "server error" that was actually a limit —
the opposite of the intended behaviour.

---

## D19 — Migrations take the advisory lock before touching the schema

**Decided.** `pg_advisory_lock` is acquired before `CREATE TABLE IF NOT EXISTS schema_migrations`.

**Why.** Found by a failing test. `IF NOT EXISTS` is not safe against a concurrent identical
create — two instances booting together raced in the system catalog and one crashed. Since several
control-plane instances are expected to start at once, this was a real production defect.

---

## D20 — No published SDK

**Decided.** `examples/` ships copy-paste clients for Python, TypeScript, curl, and MCP. No npm or
PyPI package.

**Why.** The integration is one POST and one POST. A published SDK would carry versioning,
release, and security-patch obligations larger than the friction it removes. The examples are
complete working files, including the part that actually matters — the `try`/`except` shape that
leaves an effect unreported when the outcome is genuinely unknown.

**Would change it if:** integration feedback shows people repeatedly getting that error handling
wrong. That is the one thing a library could enforce that documentation cannot.

---

## D21 — MCP implemented directly, not via the official SDK

**Decided.** `@modelcontextprotocol/sdk` was installed, then removed. `src/mcp/protocol.ts`
implements the JSON-RPC surface Ratchet needs in ~130 lines.

**Why.** The SDK's server transports own the HTTP request/response lifecycle, which fights
Fastify's — and more importantly they assume a *session*, while Ratchet's HTTP transport is
deliberately stateless so every request is authorised on its own key and no state is shared
between tenants. Wrapping the SDK to undo that was more code than implementing the protocol.

Doing it directly also lets one definition source (`src/mcp/tools.ts`) feed the stdio transport,
the HTTP transport, and the published manifest, with an e2e test asserting all three agree.

**What is covered:** `initialize` with version negotiation across `2025-06-18`, `2025-03-26`, and
`2024-11-05`; `tools/list` with annotations; `tools/call` with `structuredContent`; `ping`;
`resources/list`; `prompts/list`; notifications answered with `202` and no body; JSON-RPC batches;
`-32601` for unknown methods. Both transports are tested end to end, stdio by spawning a real
child process and completing a handshake.

**Would change it if:** the protocol grows features Ratchet needs — sampling, elicitation,
server-initiated notifications — where tracking the spec by hand stops being cheaper than a
dependency.

---

## D22 — `zod` removed

**Decided.** Installed, then removed unused.

**Why.** Validation is JSON Schema via Fastify's AJV, because the same schema object serves both
request validation and the generated OpenAPI document — which is what stops the published contract
drifting from the implementation. A second validation library would have been a parallel source of
truth for no gain.
