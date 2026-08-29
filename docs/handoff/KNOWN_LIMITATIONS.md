# Known limitations

What is not done, why, and what it would take. Nothing here is hidden elsewhere in the docs.

---

## 1. Live payments are not enabled

**State.** `BILLING_PROVIDER=test` is active. The test adapter performs no network I/O and issues
no charge. Every affected response carries `test_mode: true`, and the pricing page says so.

**What is genuinely implemented and tested:** webhook signature verification over the raw body
with a 300-second replay window (tested against tampering, wrong secrets, stale timestamps,
malformed headers, and a missing secret), provider event-id deduplication, the append-only credit
ledger, concurrent-replay safety, plan entitlement, overage arithmetic, and monthly rollover.

**What is not:** the single outbound call that creates a checkout session.
`startCheckout` throws `BillingUnavailable` when Stripe credentials are present, rather than
running an untested code path against real money.

**To enable:** set `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; point
a Stripe webhook at `POST /v1/billing/webhook/stripe` for `checkout.session.completed`; implement
the session creation in `src/domain/billing.ts::startCheckout`, setting `workspace_id` and
`pack_id` in session metadata — the receiving half already reads them.

**Why it was left this way.** Writing a live payment call that has never been executed and calling
it production-ready is precisely the unverified claim this project refuses to make.

---

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

## 7. No deployment has been performed

No hosting or DNS credentials were available. The build is verified: `npm run build` produces a
working `dist/`, the compiled artifact was smoke-tested in production mode, a multi-stage
`Dockerfile` runs non-root under tini with a healthcheck, and `docker-compose.yml` brings up
database, control plane, and worker together.

**To deploy:** any container platform. Set `DATABASE_URL`, `AUTH_SECRET` (32+ random characters),
`PUBLIC_URL`, `NODE_ENV=production`. Run `node dist/api/server.js` for the control plane (scale
freely) and `node dist/worker/main.js` for the worker (at least one, always on). Migrations run on
API boot behind an advisory lock.

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
