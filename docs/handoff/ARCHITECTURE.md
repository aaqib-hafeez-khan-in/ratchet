# Architecture

## The shape of the problem

An agent wants to perform a side effect. The agent may crash, may be one of several workers, may
be retried by a supervisor, and may be a different model on a different machine than the one that
started the work. Nothing in that picture has a reliable shared memory of "did this already
happen?"

Ratchet supplies exactly that, and nothing else. It is a gate, not an executor.

The deliberate consequence of *not* executing anything is that Ratchet needs no sandbox, no
credential vault, no outbound access to customer systems, and no worker fleet running untrusted
code. Its blast radius is a database of hashes and state transitions.

## Topology

```
   agents (REST or MCP)
        │
        ▼
┌───────────────────────────────┐
│ control plane                 │  stateless · horizontally scalable
│ Fastify                       │  may run on serverless infrastructure
│  /v1  REST + OpenAPI          │
│  /mcp Streamable HTTP         │
│  /    static web + console    │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│ Postgres                      │  the only source of truth
│  effects        state machine │
│  effect_policies rules        │
│  spend_windows  ceilings      │
│  ledger_entries append-only   │
│  api_keys       hashed        │
│  audit_events   history       │
│  webhook_*      delivery      │
└───────────────▲───────────────┘
                │
┌───────────────┴───────────────┐
│ worker                        │  MUST be long-running
│  lease reaper       every 2s  │  multiple replicas safe
│  webhook delivery   every 1s  │  (FOR UPDATE SKIP LOCKED)
│  retention GC       every 5m  │
└───────────────┬───────────────┘
                ▼
        customer endpoints (signed, SSRF-guarded)
```

### Why the worker cannot be serverless

A lease that expires with no report **must** become `indeterminate` even if no request ever
arrives again. That is a timer, not a request handler. A serverless function cannot hold one, and
a scheduled invocation at minute granularity would leave leases stale for up to a minute — long
enough for a caller polling `begin` to be told `in_flight` about a worker that died.

The inline path in `beginEffect` mitigates this: when a caller encounters a `pending` effect whose
lease has already expired, it performs the transition itself under the same row lock. So the
system is *correct* without the worker, and the worker exists to make the transition timely and to
fire webhooks for effects nobody asks about again. Both paths take the same row lock, so they can
never disagree.

## The state machine

```
                    ┌───────────────────┐
  begin ───────────▶│ awaiting_approval │──── reject ────▶ denied
  (require_approval)└─────────┬─────────┘
                              │ approve, then a later begin
  begin (allow) ─────────────▶├────────────▶ pending ── report(succeeded) ──▶ succeeded ──┐
                              │                 │                                          │
                              │                 ├─ report(failed) ──▶ failed ─ begin ──▶ pending
  begin (deny) ───────────────┴──▶ denied       │                                          │
                                                └─ lease expires ──▶ indeterminate         │
                                                                          │                │
                                     on_indeterminate = retry ────────────┤──▶ pending     │
                                     on_indeterminate = block | probe ────┤  (caller blocked)
                                                          resolve ────────┴──▶ succeeded | failed | cancelled
                                                                                           │
                            every later begin with the same key ◀──── duplicate + result ──┘
```

Invariants:

- **Only `pending` holds a lease.** The reaper's sweep index is partial on that state, so it stays
  small no matter how many effects exist.
- **`succeeded` is terminal and replayable.** Its `result` is returned to every later caller.
- **`indeterminate` is never resolved automatically.** Only an explicit `resolve`, or a policy that
  says a retry is safe for that effect type, moves it.
- **`attempt` only increases**, and each grant issues a fresh `lease_token`.

## At-most-once

Enforced by one line of schema:

```sql
CREATE UNIQUE INDEX effects_ident_idx
  ON effects (workspace_id, effect_type, idempotency_key);
```

`beginEffect` issues `INSERT ... ON CONFLICT DO NOTHING RETURNING *`. Exactly one concurrent
caller gets a row back; everyone else falls through to `SELECT ... FOR UPDATE` and reads the truth.
There is no application-level check-then-act, so there is no window to lose.

Verified by `test/integration/concurrency.test.ts`: 25 simultaneous callers on one key produce
exactly one `execute`, one effect row, and one metered unit.

## Fencing

A lock alone is not enough. A worker can stall past its lease, wake up, and try to report — by
which time another attempt may have started and finished. `lease_token` is a fencing token: it is
regenerated on every grant, and `reportEffect` only accepts the current one. A stale holder gets
`lease_lost` with an explicit warning not to assume its work counted.

## Payload fingerprinting

`canonicalFingerprint` sorts object keys recursively before hashing, so `{a:1,b:2}` and `{b:2,a:1}`
agree. A `begin` whose fingerprint differs from the stored one is rejected with
`idempotency_key_reuse` — that collision would otherwise hide a real, distinct action behind an
unrelated record. Only the 32-byte digest is stored.

## Concurrency: three things that bit, and how they were fixed

All three were found by tests, not by reading.

### 1. Deadlock between the foreign key and metering

`INSERT INTO effects` takes a `KEY SHARE` lock on the parent `workspaces` row. Metering later
takes that row `FOR UPDATE`. Two concurrent creations deadlocked: each held `KEY SHARE` while
waiting for the other to release so it could upgrade.

Fixed by establishing a global lock order — **`workspaces` → `effects` → `spend_windows`** — and
taking the exclusive workspace lock *before* the insert. An unlocked pre-check keeps this off the
hot path: only a genuinely new effect pays for the lock, so duplicates, in-flight checks, and
retries never touch it. That is also exactly the set of calls that are never metered.

### 2. Lost update on the first spend of a day

`SELECT ... FOR UPDATE` locks nothing when the row does not exist. On the first spend of a day,
twenty concurrent callers each read `0`, each passed the ceiling check, and all twenty incremented
— overshooting a budget every one of them individually respected.

Fixed by materialising the row before locking it: `INSERT ... ON CONFLICT DO NOTHING`, then
`SELECT ... FOR UPDATE`. `reserveSpend` now locks and reads **all** scopes, then validates **all**
of them, then increments — a three-phase commit against a fixed scope order, so concurrent
reservations serialise cleanly and cannot deadlock against each other.

Verified: 20 concurrent callers against a budget for 5 admit exactly 5, and the recorded spend
lands exactly on the ceiling.

### 3. Write contention on `api_keys`

`last_used_at` was written on every authenticated request, taking an exclusive row lock that
contends with the `KEY SHARE` lock in-flight `begin` calls hold on the same key. Coarsened to at
most once a minute per key, which loses no useful information.

## Metering, and why it is the last write

Metering locks the workspace row, so it runs as the final statement of the `begin` transaction to
hold that lock for the shortest possible time. If it fails — insufficient credit — the whole
transaction rolls back and no half-created effect remains. Tested explicitly.

Within the monthly allowance, metering is a counter increment and writes no ledger row. Past it,
credit is drawn and an immutable ledger entry keyed on the effect id is written, so a replayed
transaction cannot double-charge.

## Two accounting systems, deliberately separate

| | Ratchet's revenue | The customer's external spend |
|---|---|---|
| Stored in | `ledger_entries`, `workspaces.credit_micros` | `spend_windows` |
| Unit | gated effects | declared cost of the underlying action |
| Who holds the money | Ratchet | the customer's own vendors |
| Purpose | billing | enforcing ceilings |

Conflating these would be both a correctness bug and a dishonest one — it would look like Ratchet
was charging for an agent's Stripe fees. They never touch.

## Webhook delivery

Claimed with `FOR UPDATE SKIP LOCKED` so replicas never double-send. Signature covers
`timestamp.delivery_id.body`, so a receiver can reject forgeries *and* replays of one delivery
under another id. Retry classification is deliberate: 5xx, 408, and 429 retry with exponentially
backed-off full jitter; other 4xx and any 3xx are permanent failures and dead-letter immediately,
because a receiver that rejected the payload will reject it again.

Enqueue is idempotent on a digest of the event payload, so a retried transaction cannot produce a
duplicate delivery.

## SSRF: two independent layers

1. **Registration time** — `validateWebhookUrl` rejects non-https, embedded credentials, non-web
   ports, IP literals, and hosts outside an optional allowlist.
2. **Delivery time** — `resolvePublicAddress` re-resolves DNS on *every* attempt and the socket is
   **pinned** to the address just checked, closing the rebinding window between check and connect.
   A host that resolves to *any* private address is refused outright rather than filtered down to
   its public answers.

Node's built-in HTTP client is used rather than a third-party one: it never follows redirects, it
supports the `lookup` hook that makes pinning possible, and it removes a dependency that carried
known advisories.

## Request path

```
onSend         security headers, no-store on /v1, CSP on HTML
preParsing     raw body captured ONLY for signature-verified webhook routes
rate limit     per API-key prefix, falling back to IP
preHandler     requireKey (agents) or requireConsole (session or key)
validation     AJV against src/api/schemas.ts, additionalProperties rejected
handler        thin: parse, call domain, serialize
error handler  ApiError → stable code; 5xx → request id only
```

`begin` and `report` are key-only and unreachable from a browser session. Reads and operator
actions accept a session cookie (SameSite=Lax, so cross-site POSTs are blocked) or a scoped key.

## MCP

`src/mcp/tools.ts` is the single definition source, consumed by the stdio transport, the HTTP
transport, and the published agent manifest — an e2e test asserts all three agree, so they cannot
drift.

The HTTP transport is stateless: every request is authorised on its own, so no session state is
shared between tenants and the endpoint scales like the rest of the control plane. `GET /mcp`
returns `405` rather than holding an idle SSE stream open for messages Ratchet never sends.

Tool results carry a `next_step` field written for a model to read literally. Every decision other
than `execute` begins with the word `STOP`, because the failure mode this product exists to
prevent is a model reading `duplicate` and trying again anyway.

Tool-level failures return a normal result with `isError: true` and a readable code, not a
JSON-RPC protocol error, so a model can act on them instead of seeing a transport fault.

## Technology choices

| Choice | Why |
|---|---|
| Postgres | The design needs `FOR UPDATE`, `SKIP LOCKED`, partial indexes, and advisory locks. SQLite has none of the concurrency semantics this depends on |
| Fastify | Schema-first, so validation and the published OpenAPI derive from one object and cannot drift |
| Plain SQL, no ORM | The correctness of this system lives in its lock ordering. An ORM would hide exactly the thing that must stay visible |
| Static HTML + ES modules | The web surface is five pages. A framework would add a build step and a dependency tree for no benefit |
| Node built-in HTTP for webhooks | No redirect following, socket pinning via `lookup`, one fewer dependency |
| No SDK package | The API is one POST. An SDK would be more maintenance than integration cost saved. `examples/` carries copy-paste clients instead |

Nine production dependencies: `fastify`, five Fastify plugins, `fastify-plugin`, `pg`, and
`dotenv` — all exact-pinned. `npm audit --omit=dev` reports zero vulnerabilities. Two more
(`@modelcontextprotocol/sdk`, `zod`) were installed during development and removed once it was
clear nothing used them; see DECISIONS D21 and D22.
