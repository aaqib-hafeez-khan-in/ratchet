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

**Live mode is now exercised. Done 2 Sep 2026, with a real card.**

A $25 credit pack was bought through the hosted Checkout page on production, paid with a real
card. Verified afterwards by `scripts/verify-live-payment.mjs` against a baseline taken before
the purchase:

- **one** new `topup` ledger entry, $25.00, `provider=stripe`, on the buying workspace — not two,
  which is the failure that would matter;
- **zero** balance mismatches across every workspace in the database, where a mismatch is any
  `credit_micros` that disagrees with the sum of that workspace's ledger deltas. That is the
  check that catches a payment which credited a balance without a row, or a row without a
  balance.

That is the whole of what Stripe's dashboard cannot tell you: whether the money became credit
*here*, exactly once.

**It also found a real defect, which is the argument for doing it at all.** Stripe returns the
buyer to `/console?checkout=success`; the parameter was never read, and the API key is held in
memory only, so it does not survive the round trip. The customer landed on a page headed "Create
a workspace" with no acknowledgement — the reading of which is that the payment failed, and the
response to which is to pay again. Fixed, and pinned by `test/e2e/checkout-return.test.ts`,
including the rule that the redirect must never carry a credential to make the session survive.

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

## 2. Rate limits are approximate, in two specific ways

**Corrected 2 Sep 2026.** This section described the limiter as per-process and in-memory,
allowing N instances to serve N× the published rate. That was fixed by
`src/api/shared-rate-limit.ts`, which shares counters across instances through Postgres
without putting the database on the request path — each instance counts locally, pushes its
delta in the background, and answers from `globalAtLastFlush + unflushedLocal`. The entry
outlived the fix, which is the third time in two days a limitation here has described a
state the system had already left.

Two real approximations remain, both deliberate:

**Between flushes, an instance is behind.** `incr` never awaits the database — that is the
whole point, since the gate itself costs ~2.5 ms and a round trip per call to police a
ceiling almost nobody approaches would be a poor trade. The cost is a window, bounded by the
flush interval, in which several instances can each be under the limit locally while their
sum is over it. The overshoot is bounded by the flush interval, not by the number of
instances, which is what makes it acceptable.

**Windows are fixed to wall-clock boundaries**, not sliding: `Math.floor(now / window) *
window`. A caller who times a burst across a boundary can therefore receive up to **twice**
the published limit in a rolling sixty seconds — the tail of one window plus the head of the
next. This is the standard trade-off of fixed-window limiting, and it is the honest reason
the manifest's numbers are a ceiling on sustained rate rather than a guarantee about any
arbitrary sixty-second slice.

It also caused a test flake worth recording, because the failure looked like a product bug:
`plan-limits.test.ts` burst 125 requests against a 120/min limit in ~300 ms and asserted the
next one was refused. On roughly one run in two hundred the burst straddled a boundary, the
counter reset halfway through, and nothing was throttled. It never failed locally. The test
now drives to twice the limit, so one boundary cannot save the caller.

---

## 3. New-effect creation serialises per workspace

The lock ordering that fixes the metering deadlock (ARCHITECTURE, and DECISIONS D5) means creating
a new effect takes an exclusive lock on the workspace row for the transaction. Duplicates,
in-flight checks, and retries skip it entirely.

**Measured** (`npm run stress 4`, 31 Aug 2026, Apple M5 Pro, local Postgres): 200 concurrent
callers on *distinct* keys complete in 202 ms and on *one* key in 219 ms — contention is nearly
free, because the unlocked pre-check means duplicates never take the workspace lock at all.
Sustained throughput plateaus near **680 rps**, and it is pool-bound (`DB_POOL_MAX` = 10), not
lock-bound. The serialisation becomes the binding constraint only above that, and only for *new*
effects in a single workspace.

**Fix when needed:** shard the counter — replace `workspaces.period_decisions` with N rows per
workspace, pick one by hash, and sum on read. Standard, and does not disturb the lock order.

---

## 4. Three-node database with automatic failover — single region

*Updated 1 September 2026.* Three nodes in `sjc`, one per zone, so quorum
survives losing any single zone:

| machine | role | zone |
|---|---|---|
| `857597a4492d58` | primary | `e4b5` |
| `7845455b310328` | standby | `7494` |
| `d89359da0e5118` | standby | `22d6` |

Both standbys stream at 0 bytes lag, and all three report identical row counts
from their own Postgres on port 5433.

**Automatic failover works, and the quorum arithmetic was verified rather than
assumed** by running Fly's own validator directly:

```
visible=1 total=2  ->  rc=1  quorum can not be met
visible=1 total=3  ->  rc=1  quorum can not be met
visible=2 total=3  ->  rc=0  promotion allowed
```

That is why two nodes were not enough: a standby that lost the primary saw one
of two and refused to promote. With three it sees two of three and promotes.

**Verify on port 5433, not 5432.** Each node runs PgBouncer on 5432 which
proxies to the primary, so `pg_is_in_recovery()` asked through it reports
`false` on a standby and looks alarmingly like a second primary. The same
mechanism is why the application is indifferent to which node it reaches.

**`max_slot_wal_keep_size` is 2 GB.** It was unlimited, which meant a replica
that died and stayed dead would retain WAL on the primary until the disk filled
and writes stopped — turning a redundancy feature into an outage. A stale slot
is now invalidated and that replica needs rebuilding instead: prefer a broken
replica over a dead primary.

**Failover drill performed 1 September 2026.** Timeline:

| | |
|---|---|
| `fly machine kill` on the primary | Fly restarted it in ~20s, *faster than repmgr's timers* — it came back as primary and **no promotion occurred** |
| `fly machine stop` (stays down) | standby `d89359da0e5118` promoted itself at **+55s** |
| API recovery | `/readyz` 200 **10s after promotion**, ~65s total outage |
| old primary restarted | rejoined as a **standby** in ~37s — no split-brain |
| after | all three nodes identical, both standbys streaming at 0 lag |
| integrity | backup re-verified **450 receipts across 71 chains** from a restored copy, 0 bad |

The kill result is worth remembering: for a *process* crash the platform wins
the race and failover never runs. Promotion is for a node that stays gone.

**Replication is async**, so a commit that has not shipped when the primary dies
is lost. Lag runs at 0 bytes, but the exposure is real and is the honest cost of
this design.

**The drill found two bugs that would have broken the nightly backup**, both
caused by moving from one node to three:

- `flyctl` picks a machine per invocation, so `pg_dump` wrote `/tmp/b.dump` on
  one node and `sftp` looked for it on another. Every ssh call is pinned to one
  machine now.
- The pinning variable was called `NODE`, which `actions/setup-node` exports as
  the path to the node binary — so the discovery never ran and
  `/opt/hostedtoolcache/.../bin/node` was passed to `--machine`.

**Still true: single region.** Cross-region callers pay the round trip, and
multi-region would require rethinking the uniqueness guarantee — not a small
change.

**A standby can be streaming and still not hold your data.** On 1 Sep 2026 one
node stopped applying WAL for 34 minutes while reporting `streaming`, holding a
healthy replication slot, and sitting idle at 0.39 load. It was found only
because a migration added a column that two nodes had and one did not. A restart
cleared it and the slot had preserved its position, so nothing needed rebuilding.

`replication-watch` in the worker now samples this every minute and `/workerz`
reports `replication: ok | degraded | unobserved`. Two things to know when
reading it:

- **Do not trust `replay_lag`.** It measures how long ago the last applied
  transaction committed, which on a quiet database is a statement about traffic,
  not health — it read 37 minutes on a cluster doing almost nothing. Byte
  distance is the honest measure.
- **A replay position pinned at a segment boundary while the primary advances is
  a wedged receiver**, and is dangerous well before the byte distance looks
  alarming. Restart that node; if it recurs, rebuild it.

Full account: [`INCIDENT_2026-09-01_FROZEN_STANDBY.md`](INCIDENT_2026-09-01_FROZEN_STANDBY.md).

---

## 4b. Surge containment is absolute, not learned

`surge_per_hour` is a number an operator chooses. There is no relative rule
("10x the trailing 7-day median"), so a workspace that never configures anything
gets no containment at all — and the workspaces most likely to need it are the
ones least likely to have configured it.

A learned baseline needs history that only started being collected on 31 August
2026, and a wrong automatic threshold refuses real work. The console suggests
3x the busiest hour in the last 30 days, which is guidance, not enforcement.

Also: windows are hourly. A burst inside one minute that stays under the hourly
ceiling passes untouched.

See `docs/handoff/CIRCUIT_BREAKER.md`.

---

## 4c. The default key can switch off its own containment

Circuit routes require `policies:write`, and the key issued at signup holds every
scope. An operator who hands that key to an agent has an agent that can close its
own breaker.

The console's key form already defaults to "Gate only (least privilege)", so the
exposure is narrower than it first appears: it is specifically the signup key,
which is full-scope and is what a quickstart invites you to paste into an agent.

There is no code fix that does not break legitimate use — the default key is an
operator key and has to be. The docs end the containment section with the
two-scope agent key and the reason for it. Worth doing properly: issue a
gate-only key alongside the operator key at signup.

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

## 7. Operated by one person

Live at `https://ratchetgate.com` (Fly.io, region `sjc`): two `shared-cpu-1x` control-plane
machines (Fly auto-stops the idle one), two workers, and a three-node Postgres cluster with
automatic failover. `scripts/deploy.sh` gates every release on a clean pushed tree, CI green
for that exact commit, staging running that same commit, and a passing smoke test.

**Corrected 1 Sep 2026.** This section previously described a single control plane, a single
worker, one 1 GB Postgres, no alerting and no running backup. All five had ceased to be true,
and the file is public — so it was advertising that nobody was watching a service where
somebody now is. A stale limitations list is worse than none: it is read as current.

What is actually true now:

- **Alerting exists.** A scheduled GitHub workflow probes production and emails on failure;
  it covers liveness, the worker loops, whether the gate still gates, and replica health.
  See [`ALERTING.md`](ALERTING.md).
- **Backups run nightly and are succeeding** (`.github/workflows/backup.yml`: dump → restore
  → re-verify every receipt signature → ship off-machine). The four repository secrets it
  needed are in place.

**What remains genuinely limited, and is the honest content of this section:**

- **One person operates it.** There is no rota and no second pair of eyes. Alerting reaches
  one inbox. This is the real single point of failure, and no amount of infrastructure
  changes it.
- **Fly volume snapshots not enabled.** `flyctl pg backup enable -a ratchet-gate-pg` needs an
  interactive terminal (the non-interactive form advertises a `--yes` flag the command does not
  accept). The nightly logical backup is the working protection; this would be defence in depth.
- **Incidents are found by deploying, sometimes.** A standby stopped replaying on 1 Sep and was
  caught only because a migration exposed it. That specific gap is now monitored — but the
  lesson generalises, and there is no reason to assume it was the last one of its kind.
  See [`INCIDENT_2026-09-01_FROZEN_STANDBY.md`](INCIDENT_2026-09-01_FROZEN_STANDBY.md).

---

## 8. Multi-instance operation — exercised once, in production

Every worker claim uses `FOR UPDATE SKIP LOCKED`, migrations are advisory-locked, and the control
plane holds no local state.

**Verified 31 Aug 2026** against the live service running two app machines: 25 concurrent `begin`
calls on one idempotency key produced exactly one `execute`, one effect id, one lease, and one
vendor key. The gate holds across processes, not merely within one.

Still unexercised: two *workers* at once (one runs today), and any failover, since there is no
replica to fail over to — see §4.

**One caveat that is easy to forget:** rate limiting is per-process (§2), so N app instances
multiply the effective limit by N. Adding instances quietly loosens every published ceiling.

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

## 11b. Claude / Anthropic listing: what is actually possible

Ratchet works with Claude Code, Claude Desktop, and Cursor **today**, via the stdio MCP server —
the operator pastes a key into a config file. That is documented on `/start` and works now.

What is **not** true, and must not be claimed:

- **It is not listed in any Anthropic-run directory.** Nothing has been submitted and nothing has
  been reviewed or approved.
- **It cannot be listed in a one-click connector directory yet.** Those flows expect OAuth 2.1
  with dynamic client registration so a user can authorise without handling an API key by hand.
  Ratchet's remote MCP endpoint authenticates with a static bearer token only.

The order of work to change that:

1. Publish `ratchet-mcp` to npm (blocked on the owner's npm login).
2. Implement OAuth 2.1 + dynamic client registration on `/mcp`.
3. Submit to the MCP registry, then to any provider directory that accepts submissions.

Steps 1 and 2 are prerequisites, not optional polish: a directory listing that requires a
hand-pasted key is not a listing anyone will complete. *Directory requirements change; confirm
them at submission time rather than trusting this note.*

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

## ~~A flaky security test~~ — fixed 2 Sep 2026

`test/integration/isolation.test.ts` → `the plaintext secret is never stored` failed
intermittently for weeks and never in isolation. **The product was never wrong. The test
was.**

The key format is `rk_<env>_<prefix>_<secret>` and the secret is base64url — an alphabet
that **includes the underscore**. The test recovered it with `plaintext.split('_').pop()`,
which returns whatever follows the last underscore *inside the secret itself*.

Measured over 200,000 generated keys:

| | Wrong secret extracted | False CI failure |
|---|---|---|
| `split('_').pop()` | **39.71%** | **1.96%** |
| `split('_').slice(3).join('_')` | 0.00% | 0.00% |

Two separate defects, and the quieter one was worse:

- **The test was weaker than it claimed on two runs in five.** Forty percent of the time it
  asserted against a truncated fragment rather than the whole secret — passing, while
  checking less than it said. Nobody would have noticed.
- **One run in fifty failed for no reason.** When the fragment happened to be short and
  made only of hex characters, it appeared inside the 64-character digest by chance. Three
  red CI runs were blamed on the product.

The fix splits off the three known leading fields and rejoins the rest, which is how the
product's own `KEY_RE` reads a key, and asserts the extracted secret is at least 32
characters — so if extraction ever breaks again it fails loudly instead of silently
weakening every assertion beneath it.

**The general lesson is the one worth keeping:** a test that is intermittently red is often
also quietly wrong when it is green, and the green failures are the expensive ones. The
earlier note here said "it should be diagnosed rather than retried". That was correct.

## Error details are inconsistently cased

The wire contract is snake_case (CLAUDE.md §6), and error `detail` objects are
part of the wire. They are not consistent: `budget_exceeded` emits
`limitMicros`, `known_runtimes` elsewhere is snake_case, and the validation
errors passed through from Fastify use their own shape.

`run_budget_exceeded`, added 1 September 2026, follows the contract. The older
ones were left alone deliberately — changing an established error's shape is a
breaking change for anyone parsing it, and doing that as a drive-by while
building something else is how consumers get broken quietly.

Worth fixing in one deliberate pass, with a version note, rather than one error
at a time.
