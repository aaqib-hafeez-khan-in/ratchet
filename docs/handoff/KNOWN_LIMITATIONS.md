# Known limitations

What is not done, why, and what it would take. Nothing here is hidden elsewhere in the docs.

---

## 1. Payments are wired but have only been exercised in Stripe test mode

**State.** The full Stripe path is implemented and verified: `startCheckout` creates real
Checkout Sessions via Stripe's API, and the signed `checkout.session.completed` webhook credits
the workspace ledger.

**Verified against Stripe's real API with a test key:** a Checkout Session was created and
returned a `checkout.stripe.com` URL; a real `checkout.session.completed` event triggered through
the Stripe CLI was delivered to the endpoint and credited $10.00; two validly signed replays of
that event returned `applied: false` and left the balance and the single ledger row untouched;
tampered bodies, wrong-secret signatures, stale timestamps, and missing headers were all refused
with `400`; and the credited balance was then spent on a gated effect past the free allowance,
drawing exactly the plan's 200-micro overage rate.

**Now verified against the deployed instance**, not just locally: Stripe delivered
`checkout.session.completed` over the public internet to `ratchet-gate.fly.dev`, signed with the
endpoint's own secret, and $25.00 was credited. A real refund was then issued through the Stripe
API, and `charge.refunded` reversed it to zero. The refund was $30 against a $25 credit, so the
"never reverse more than was credited" guard was exercised by a real payload rather than a fixture.
All deliveries reported `pending_webhooks=0` — none failed or retried.

**Not yet exercised:** a live-mode key. Nothing in the code path differs between test and live
keys — Stripe's API is identical and the key is passed through unchanged — but that is reasoning,
not evidence, and it is recorded here as such. Before switching to `sk_live_`, run one real
low-value purchase end to end and confirm the ledger.

**Also not exercised:** the hosted Checkout page itself was not driven through a browser, because
that means typing card details into a form. The session URL is produced and valid; completing it
by hand takes one click with Stripe's `4242 4242 4242 4242` test card.

**Deliberate gate.** A secret key alone selects Stripe but does **not** open checkout. Both the
key and the webhook secret are required, because taking a payment that cannot be confirmed would
leave a customer charged and uncredited. The API response and `npm run stripe:check` name the
missing variable rather than silently falling back to the test adapter.

**Refunds and disputes are implemented and verified in production.** `charge.refunded` and
`charge.dispute.created` reverse credit through a compensating ledger entry, capped at what was
credited, idempotent on the event id. **Subscriptions are not implemented** — only one-time credit
purchases. Recurring plan billing would need `customer.subscription.*` handling and is not present.

## 1b. Sales tax and VAT are not collected by default

**State.** Credit purchases charge the pack price with no tax added. Stripe Tax support is
implemented but **off** unless `STRIPE_AUTOMATIC_TAX=true`.

**Why off by default.** Enabling it without a head-office address and tax registrations configured
in the Stripe dashboard makes Stripe reject *every* checkout — verified against the real API,
which returns "You must have a valid head office address to enable automatic tax calculation".
A default that breaks payments the moment credentials appear would be worse than no support.

**To enable:** configure origin address and registrations at
`dashboard.stripe.com/settings/tax`, then set `STRIPE_AUTOMATIC_TAX=true`. Checkout then also
collects a billing address, which Stripe needs to determine jurisdiction. Tax is added on top of
the pack price; the credit granted is always the pack's face value, so paying $10.80 for $10 of
credit is correct — the $0.80 is tax, not product.

**Whether you must:** a business decision, not a technical one. Selling prepaid credit can create
sales-tax or VAT obligations depending on where you and your customers are. This project does not
give tax advice and does not assume an answer.

## 2. Rate limits are per-process

`@fastify/rate-limit` uses an in-memory store, so an N-instance deployment allows roughly N× the
configured rate. Fine for one or two instances; wrong at scale.

**Fix:** point the plugin at a Redis store. Contained change, one config block. Deferred because it
would add a second stateful dependency for a problem that does not exist at one instance.

---

## 3. New-effect creation serialises per workspace

The lock ordering that fixes the metering deadlock (ARCHITECTURE, and DECISIONS D5) means creating
a new effect takes an exclusive lock on the workspace row for the transaction. Duplicates,
in-flight checks, and retries skip it entirely.

**Measured:** 200 concurrent callers complete in 16–19 ms, so this is not a practical ceiling at
current scale. It becomes one somewhere in the low thousands of *new* effects per second for a
single workspace.

**Fix when needed:** shard the counter — replace `workspaces.period_decisions` with N rows per
workspace, pick one by hash, and sum on read. Standard, and does not disturb the lock order.

---

## 4. Single-region, single-primary database

No read replicas, no multi-region, no automatic failover. Correctness depends on a single
authoritative Postgres, which is the right trade for a service whose entire value is one
authoritative answer.

**Consequence:** cross-region callers pay the round trip, and a primary failure is an outage.
**Fix:** managed Postgres with automated failover. Multi-region would require rethinking the
uniqueness guarantee and is not a small change.

---

## 5. Retention deletes replayable results

When an effect passes `retention_days`, its record — including the recorded `result` — is deleted.
A `begin` with that key afterwards is a *new* effect and returns `execute`.

This is correct and intended: retention is bounded, and an unbounded ledger of every effect
forever is a different product. But it means retention is a **safety parameter, not just a storage
one**. Set it longer than the window in which a duplicate could plausibly be attempted. The
default is 7 days; plans allow up to 90.

Documented in the policy table. A future improvement would be tombstoning the key while dropping
the payload, preserving duplicate suppression at a fraction of the storage.

---

## 6. The worker must be long-running

It expires leases on a timer whether or not a request is in flight. A serverless function cannot
do this. Deploy it as a container.

**Mitigation already in place:** `beginEffect` performs the same transition inline when it
encounters an expired lease, under the same row lock — so the system is *correct* without the
worker, and the worker makes transitions timely and fires webhooks for effects nobody asks about
again. Both paths are tested and produce identical results.

---

## 7. Not yet deployed (the path is built and rehearsed)

No hosting or DNS credentials were available. The build is verified: `npm run build` produces a
working `dist/`, the compiled artifact was smoke-tested in production mode, a multi-stage
`Dockerfile` runs non-root under tini with a healthcheck, and `docker-compose.yml` brings up
database, control plane, and worker together.

**Rehearsed, not assumed:** the production images were built and the full stack — database,
control plane, worker — was run under `docker compose`, and the complete workflow was driven
through it: signup, gate, report, replay, MCP tool listing, a crashed lease swept to
`indeterminate` by the worker container, the next caller correctly `blocked`, and the analytics
flusher writing from inside the container. That rehearsal found and fixed a real defect: compose
published the database on port 5433, colliding with the dev database.

**To deploy:** `npm run deploy:fly` (idempotent; creates app, managed Postgres, secrets, both
process groups, then verifies). `npm run deploy:preflight` gates it. Any container platform works;
only `fly.toml` is Fly-specific.

**What still requires the owner:** a hosting account. Every provider needs an interactive browser
login, so this is the one step that cannot be automated from here.

---

## 8. Multi-instance operation is designed but unexercised

Every worker claim uses `FOR UPDATE SKIP LOCKED`, migrations are advisory-locked, and the control
plane holds no local state. Concurrency is tested *within* a process and the migration race is
covered, but two API instances plus two workers were never run simultaneously against one database.

---

## 9. Console limitations

- Password-less: a session cookie is issued at signup, and a key can be supplied via `?key=`
  (held in memory only, never in `localStorage`). There is no sign-in-later flow, no password
  reset, and no second factor.
- One operator per workspace. No teams, roles, or invitations.
- No mail is sent. The email address identifies the workspace owner and nothing more; the field
  says so.
- Policies are readable and editable via the API but the console only *displays* them. Editing is
  `PUT /v1/policies/{effect_type}`.
- Effect detail is summarised in a table; there is no per-effect drill-down page.

These are deliberate. The console exists to support credentials, usage visibility, and the
resolve/approve actions that have no API-only equivalent for a human. Everything else is the API.

---

## 10. No published SDK package

`examples/` carries complete working clients for Python, TypeScript, curl, and MCP, but nothing is
published to npm or PyPI. The agent manifest names the stdio command as `npx -y ratchet-mcp` while
explicitly noting it is **not yet published** and pointing at the from-source path.

**Trade-off:** a published SDK would carry versioning and security-patch obligations larger than
the friction it removes for a two-call API. Worth revisiting if integrators repeatedly get the
error handling wrong — the `try`/`except` shape that leaves an effect unreported when the outcome
is unknown is the one thing a library could enforce that documentation cannot.

---

## 11. Registry submission material is prepared, not submitted

Nothing has been submitted to any MCP registry, directory, or marketplace, and no provider has
reviewed or approved this service. The discoverability surfaces that exist are the legitimate ones:
a standards-compatible MCP server at `/mcp`, an accurate OpenAPI document, a capability manifest at
`/.well-known/agent-manifest.json`, and `/llms.txt`.

**Before submitting anywhere:** deploy to a stable public URL, set `PUBLIC_URL` so the manifest and
`llms.txt` emit real URLs, and publish the stdio server if a registry expects an installable
package.

---

## 12. Observability is structured logs and health endpoints only

No metrics export, no tracing, no dashboards, no alerting. `/healthz` and `/readyz` (which reports
real database latency) are suitable for a load balancer.

**Next step:** a `/metrics` endpoint with decision counts by type, lease-expiry rate, webhook
delivery outcomes, and queue depth. Lease-expiry rate in particular is the number an operator
would want alerting on — it is the leading indicator of agents that crash mid-effect.

---

## 13. No coverage measurement

123 tests pass across unit, integration, and e2e. No coverage tool is configured, so **no coverage
percentage is claimed anywhere.** The VALIDATION_REPORT lists what is actually covered, by name.

---

## 14. Not audited by a third party

No SOC 2, no penetration test, no compliance certification. The security controls are implemented
and tested; that is a genuine but strictly smaller claim than independent verification.
