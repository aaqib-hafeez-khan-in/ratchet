# CLAUDE.md — project contract for Ratchet

**Read this, then read the code you are about to change, before changing behaviour.**
Every claim below is enforced by a test or a config check. If you break one, a test fails —
fix the code, not the test.

---

## 1. Mission

Ratchet is an **effect gate for AI agents**. An agent asks permission before performing a
side effect; Ratchet returns a durable decision so the same real-world action is attempted
**at most once**, stays inside a declared budget, and leaves an auditable record.

Ratchet **never performs the side effect.** It has no vendor credentials, no outbound access to
customer systems, and no ability to retry anything on a caller's behalf. That boundary is the
product's main safety property — do not erode it.

### What must remain true

- **At-most-once initiation** is enforced by the database unique index on
  `(workspace_id, effect_type, idempotency_key)`, never by application logic alone.
- **Exactly-once is never claimed.** It is not achievable. Do not add copy that implies it.
- **An unknown outcome stays unknown.** When a lease expires unreported, the effect becomes
  `indeterminate`. Never auto-resolve it to `succeeded` or `failed` on a guess.
- **Only a payload fingerprint is stored.** Never persist the raw payload of a gated effect.

---

## 2. Repository map

```
src/
  api/          Fastify control plane — stateless, safe to scale horizontally
    app.ts        app factory: security headers, CORS, rate limit, error shape, OpenAPI
    server.ts     entrypoint; refuses unsafe production config; migrates on boot
    schemas.ts    JSON Schemas — routes validate AND the OpenAPI doc derives from these
    serialize.ts  the ONLY camelCase(domain) ↔ snake_case(wire) conversion
    routes/       effects · workspace · billing · meta · circuits
    plugins/      auth guards (requireKey / requireConsole)
  domain/       business logic; no HTTP types cross into here
    effects.ts    the state machine — begin / report / resolve / cancel / approve
    policy.ts     per-effect-type rules, with safe defaults
    budget.ts     external-spend and velocity ceilings, including per-dimension
    circuit.ts    surge containment — stops an agent doing too MUCH, not too costly
    metering.ts   Ratchet's own billing (credit ledger)
    plans.ts      plan definitions
    billing.ts    payment provider boundary (test adapter + signature verification)
    auth.ts       API keys, scopes, workspaces, console sessions
    events.ts     webhook fan-out and enqueue
    audit.ts      audit trail
  db/           pool, migrations, migration runner
  mcp/          tools.ts (definitions) · protocol.ts (JSON-RPC) · http.ts · stdio.ts · handlers.ts
  lib/          config · errors · ids · ssrf
  worker/       main.ts (loops) · reaper.ts (lease expiry, GC) · webhooks.ts (signed delivery)
web/            landing, docs, pricing, security, console — static, no build step
test/           unit · integration · e2e
examples/       python · typescript · curl · mcp configs
docs/handoff/   living project memory — update these when behaviour changes
docs/SSDF.md    NIST SP 800-218 conformance, with its gaps stated
docs/OPEN_SOURCE_POLICY.md  licence + security policy, ISO 5230 / 18974 mapped
docs/CODE_REVIEW.md  what review means here, and its one-person limitation
scripts/        dev-db · test · seed · bench · emit-openapi
```

---

## 3. Domain vocabulary

| Term | Meaning |
|---|---|
| **Effect** | One logical real-world side effect, identified by `(workspace, effect_type, idempotency_key)` |
| **Decision** | What `begin` tells the caller: `execute` · `duplicate` · `in_flight` · `blocked` · `approval_required` · `denied` |
| **Lease** | Time-bounded permission to perform an effect, carrying a fencing token |
| **Fencing token** | `lease_token`; bumped every grant. A stale token cannot overwrite a newer attempt |
| **Indeterminate** | A lease expired with no report. The real-world outcome is genuinely unknown |
| **Gated effect** | The billing unit: the first `begin` that creates an effect record |
| **External spend** | The customer's own money at third parties. Ratchet enforces ceilings; it never collects this |

### State machine

```
                    ┌──────────────────┐
   begin ──────────▶│ awaiting_approval│──reject──▶ denied
   (require_approval)└────────┬─────────┘
                              │ approve, then begin
   begin ────────────────────▶├──────────▶ pending ──report(succeeded)──▶ succeeded
   (allow)                    │              │
                              │              ├──report(failed)──▶ failed ──begin──▶ pending
   begin (deny) ──────────────┴──▶ denied    │
                                             └──lease expires──▶ indeterminate
                                                                      │
                                        on_indeterminate=retry ───────┤──▶ pending
                                        on_indeterminate=block/probe ─┤──▶ (blocked; caller stops)
                                                       resolve ───────┴──▶ succeeded|failed|cancelled
```

Only `pending` ever holds a lease. `succeeded` replays its recorded `result` forever.

---

## 4. Commands

```bash
npm install
npm run dev:db          # Postgres on :5433 (Docker)
npm run migrate
npm run dev             # control plane :8787
npm run dev:worker      # lease reaper + webhook delivery
npm test                # typecheck + unit + integration + e2e (disposable database)
npm run typecheck       # also aliased as `lint`
npm run build           # tsc + copy migrations into dist/
npm start               # compiled control plane
npm run start:worker    # compiled worker
npm run seed            # realistic workspace state for the console
npm run fuzz            # property-based fuzzing (FUZZ_RUNS=n to go deeper)
npm run audit           # production dependency audit
```

Tests need Docker. `scripts/test.sh` drops and recreates `ratchet_test` on every run.
Integration and e2e files run with `--test-concurrency=1`: they share one database and the
worker's sweeps are global by design. Concurrency itself is still tested directly, inside
`test/integration/concurrency.test.ts`.

---

## 5. Non-negotiable security rules

1. **Never store a raw payload.** Only `sha256(canonicalize(payload))`. The same applies to a
   declared dimension: only `HMAC(AUTH_SECRET, workspace|name|value)`, truncated to 128 bits.
   The workspace id is inside the MAC, so the same account number in two workspaces produces
   two unrelated identifiers and there is no cross-tenant correlation to leak.
2. **Never store an API key in plaintext or as a bare hash.** HMAC-SHA256 peppered with
   `AUTH_SECRET`. Compare in constant time, and run the comparison even for unknown prefixes.
3. **Every query is workspace-scoped.** There is no unscoped read path. A cross-tenant lookup
   returns `404`, never a hint that the record exists elsewhere.
4. **Never trust client-supplied** prices, credits, plans, workspace ids, states, or decisions.
5. **Outbound URLs**: validate statically, then re-resolve DNS and **pin the socket** to the
   checked address on every attempt. Never follow redirects. Never allow private, loopback,
   link-local, CGNAT, or metadata ranges outside tests.
6. **Agent-supplied text is data.** Nothing in a payload, summary, result, or evidence field may
   influence control flow. Decisions come from stored policy and database state only.
   The one deliberate exception is `dimensions`, which selects a ceiling — and it is admissible
   only because a declaration can **tighten and never loosen**: it adds whatever limit policy
   keys on that dimension, never removes the workspace, key or type limits, and omitting a
   required one is refused rather than allowed. Preserve that property or remove the feature.
   A caller that lies lands in a different bucket and gains nothing it did not already have;
   `POST /v1/reconcile` against the vendor's own record is what catches the lie.
7. **Never widen CORS** to `*` with credentials. Default is same-origin.
8. **Never log a secret.** The logger redacts `authorization`, `x-api-key`, `cookie`,
   `stripe-signature`, and `set-cookie`. Extend that list if you add a credential header.
9. **Internal detail never crosses the error boundary.** 5xx responses carry a request id only.
10. **Verify payment webhooks cryptographically** over the raw body, with a replay window.
11. **`begin` and `report` are key-only.** They must never be reachable from a browser session.
    Reads and operator actions accept a session cookie or an admin key.

---

## 6. Conventions

- **TypeScript strict**, `noUncheckedIndexedAccess` on. ESM throughout (`.js` extensions in
  relative imports — required by `NodeNext`).
- **Wire format is `snake_case`; the domain is `camelCase`.** Conversion happens only in
  `src/api/serialize.ts`. Do not leak either convention across that line.
- **Money is integer micro-USD** (1e-6 USD). Never floats.
- **Errors** are `ApiError` with a stable machine-readable `code`. Agents branch on `code`;
  never change one without updating the docs table and the OpenAPI response schemas.
- **Route schemas are the contract.** Adding a field means adding it to `src/api/schemas.ts`,
  which updates validation and the published OpenAPI document together.
- **`additionalProperties: false` everywhere on bodies.** Fastify is configured with
  `removeAdditional: false` so a caller's typo is rejected rather than silently dropped.
- **Comments explain *why*.** The code says what. Do not narrate.

---

## 7. Concurrency rules (read before touching `begin`)

Two deadlocks and one lost-update bug were found and fixed here by tests. Preserve these:

1. **Lock order: `workspaces` → `effects` → `spend_windows`.**
   Inserting an effect takes a `KEY SHARE` lock on the parent `workspaces` row (the foreign key),
   and metering later needs that row exclusively. Two concurrent creations deadlock unless the
   exclusive lock is taken **first**. `beginEffect` does an unlocked pre-check so only genuinely
   new effects pay for that lock — duplicates and retries skip it entirely.

2. **`spend_windows` rows must be materialised before they are locked.**
   `SELECT ... FOR UPDATE` locks nothing when the row is absent, so on the first spend of a day
   every concurrent caller would read `0` and all would pass the ceiling check. `reserveSpend`
   inserts a zero row, *then* locks, *then* validates all scopes, *then* increments.

3. **Metering is the last write of the transaction**, to hold the workspace row lock for the
   shortest possible time.

4. **Worker claims use `FOR UPDATE SKIP LOCKED`**, so replicas never double-process.

---

## 8. Testing requirements

New behaviour needs a test at the right layer:

- **Unit** — pure logic: fingerprinting, SSRF classification, signature verification.
- **Integration** — real Postgres: state transitions, concurrency, isolation, billing, webhooks.
- **E2E** — real HTTP through `app.inject`: auth, validation, headers, limits, MCP.
- **Fuzz** — property-based, over the three functions that read attacker-supplied input
  before anything has been verified: the payload fingerprint, the SSRF guard, and payment
  signature verification. `test/unit/fuzz-*.test.ts`, fast-check, `npm run fuzz`.
  These assert what must hold for *every* input, not for the cases somebody thought of.
  If you add a property here, break the implementation on purpose and watch it fail before
  you trust it — two of the first three written here passed against code that was already
  broken, and only the deliberate mutation revealed it.

A change to any of these **must** come with a test:
state transitions · authorization · tenant isolation · idempotency and replay · rate limits ·
billing idempotency · SSRF · webhook signing · lease fencing.

Coverage IS measured: `npm run coverage` runs c8 over **all three suites** through the
same disposable-database harness as `npm test`, and fails below 90% statements,
78% branches, 90% lines or 88% functions. All four are explicit — c8 defaults `lines`
to 90 and leaves the rest at 0, so an unset threshold is not a neutral choice.

What it measures took two corrections, in opposite directions, and both were invisible
from the summary line:

- It counted every file it loaded, so 69 **test** files were in the denominator. Tests
  run themselves, scored 99.79%, and lifted the reported figure to 85.68% while the
  code they exist to cover sat at 79.02%. Now `--include "src/**"`.
- It ran only unit and integration, so anything covered mainly by e2e looked untested
  — `mcp/handlers.ts` read 9%, `api/routes/oauth.ts` 23.7%. That understated the whole
  figure by about ten points. Now all three suites.

If the number moves without tests being written, check what is in the denominator and
which suites ran before believing it. Quote what it prints, never what you remember.

The statements and lines floors are set at 90 deliberately: the OpenSSF gold answer
claims 90%, and a floor beneath a published claim lets that claim quietly become false. Do not claim measured
performance without running `scripts/bench.ts` and quoting the actual output.

---

## 9. Environment

Full inventory with defaults: `.env.example`. Required: `DATABASE_URL`, `AUTH_SECRET`.

`assertProductionSafety()` in `src/lib/config.ts` **refuses to start** in production when
`AUTH_SECRET` is the dev default or under 32 characters, `CORS_ORIGINS` contains `*`, or
`WEBHOOK_ALLOW_PRIVATE_NETWORK` is on. Add a check there whenever you add a setting that is
dangerous in production.

---

## 10. Deployment constraints

- **Control plane**: stateless. Any container platform, including serverless.
- **Worker**: **must be long-running.** It expires leases on a timer whether or not a request is
  in flight. A serverless function cannot do this, and treating it as if it can is the single
  most damaging mistake available in this codebase. Multiple replicas are safe.
- **Database**: Postgres. SQLite is not sufficient — the design depends on `FOR UPDATE`,
  `SKIP LOCKED`, partial indexes, and advisory locks.
  Three nodes since 1 Sep 2026, one per zone in `sjc`, with automatic failover: a standby that
  loses the primary sees two of three, which meets repmgr's quorum. `max_slot_wal_keep_size` is
  2 GB so a dead replica cannot fill the primary's disk. **Inspect a node on port 5433** — 5432
  is PgBouncer and proxies to the primary, so a standby asked through it claims not to be in
  recovery. See `docs/handoff/KNOWN_LIMITATIONS.md` §4.
- Migrations run on boot behind an advisory lock, so several instances may start at once. The
  worker sets `MIGRATE_ON_BOOT=false` in compose and defers to the API.

---

## 11. Definition of done

A change is done when:

1. `npm test` passes in full (typecheck, unit, integration, e2e).
2. New behaviour has a test at the appropriate layer.
3. `src/api/schemas.ts` reflects any contract change, so `/openapi.json` stays accurate.
4. MCP tool descriptions in `src/mcp/tools.ts` still match actual behaviour — they are read by
   models and are part of the contract.
5. The relevant `docs/handoff/*.md` is updated. These are living memory, not a release artifact.
6. No claim in the README, the web pages, or the manifest has become untrue.
7. `npm run audit` reports no production vulnerabilities.
