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
path is both the free path and the cheaper path (1.58 ms versus 2.14 ms measured — an earlier
"0.22 ms" figure was timing rate-limit rejections and has been corrected).

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
breach a ceiling, and skipping it removes six queries from the metered path — measured at 3.47 ms
with budget enforcement active against 2.14 ms without.

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

## D10 — Stripe implemented only once it could actually be verified

**Originally decided.** With no payment credentials, `startCheckout` threw rather than shipping an
untested live call described as production-ready.

**Superseded** once a test key was supplied. The call is now implemented and verified against
Stripe's real API: a Checkout Session was created, a real `checkout.session.completed` event
credited a workspace, signed replays were suppressed, forgeries were refused, and the credit was
then spent at the plan's overage rate.

**The rule that produced both decisions is the same one:** implement it when it can be verified,
and say precisely how far the verification went. It has been exercised in test mode only, which is
what the docs now claim — no more.

**Built without an SDK.** Stripe's API is form-encoded; `fetch` plus `URLSearchParams` covers it in
about forty lines. Adding `stripe-node` would have meant a large dependency tree to track for
advisories, in a service whose selling point is a small auditable surface. An `Idempotency-Key`
header is sent on every call, so a retried request cannot create a second session.

---

## D23 — A secret key alone does not open checkout

**Decided.** Both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` must be present. With only the
key, Stripe is *selected* but checkout is refused, and the missing variable is named.

**Why.** Credit is applied only when the signed webhook arrives. With a key but no webhook secret,
a customer could pay and never be credited — worse than declining to sell, and invisible until
someone complains. The earlier behaviour silently fell back to the test adapter, which was worse
still: it looked like it worked.

**Also:** credit is never applied on the browser reaching the success URL. A returning browser is
not proof that payment settled, and treating it as such is a standard way to give away product.

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

---

## No third-party logos on the site — 2026-08-30

Asked to display the logos of ~60 AI companies as rotating badges. Declined, and built a
different page instead.

**Why not.** None of those companies are customers, partners, or endorsers. A wall of logos has
exactly one conventional meaning — *these companies use us* — and that would be false. It also
creates trademark exposure: nominative fair use protects *naming* a product to describe
compatibility truthfully, not reproducing its mark in a badge wall that implies sponsorship. It
contradicts the disclaimer already carried on `/docs`, and the original brief's explicit
prohibition on fabricated endorsements. Practically, a knowledgeable buyer who sees sixty logos
on a service with no public customers discounts everything else on the site.

**What was built instead.** `/works-with`, which is a router rather than a trophy case: the
reader types their stack and gets the integration path and a real snippet. It names 49 platforms
in text, grouped by *how you actually connect* — MCP, HTTP, your own model — which is the only
ordering that helps someone trying to integrate.

**The rule the page states about itself:** name a platform only where the reader can act on the
name — where there is a real path they can follow today. Never name a company purely to borrow
its credibility. That is why orchestration platforms and model runtimes are listed and vertical
AI products are described by shape rather than named: a reader can act on "n8n, HTTP Request
node", but naming a company that has no relationship with us is just borrowing.

`verified` on that page means it was run. Everything else is marked as a documented path.

---

## The beacon is self-integration, not advertising — 2026-08-30

Asked to build "some type of beacon within the site to attract bots, agents and humans".

Discovery surfaces already existed (`/llms.txt`, `/.well-known/agent-manifest.json`,
`/openapi.json`, `/mcp`). They tell an agent what the API *is*. The gap was that the agent still
had to invent the integration.

`GET /v1/integrate` closes it: runnable code for the caller's own runtime — `http`, `python`,
`node`, `langchain`, `mcp`, `ollama`. Public and unauthenticated, because an agent that has just
discovered the service does not have a key yet, and requiring one to learn how to integrate puts
a human in the middle of the only step that does not need one. Nothing returned is
per-workspace, so there is nothing to leak. `Accept: text/plain` returns just the code, ready to
pipe to a file.

Every recipe derives its idempotency key from the work itself, and says so in a comment that
survives being pasted elsewhere. A key from `uuid4()` or `Date.now()` turns the gate into an
expensive no-op, and that is the single mistake most likely to be copied. A test asserts no
recipe can regress into teaching it.

Advertised from `llms.txt` and the agent manifest, so the discovery chain resolves end to end —
also asserted by test.
