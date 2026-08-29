# Pricing and unit economics

Every number below is either a measured value from this repository or an explicitly labelled
assumption. Nothing here is a forecast, and no revenue is projected.

---

## The meter

**One unit: a gated effect** — a `begin` call that creates a new effect record for a given
`(workspace, effect_type, idempotency_key)`.

Free, and never counted:

- every repeat `begin` for the same key (`duplicate`, `in_flight`, `blocked`, `approval_required`)
- retries after a clean failure, however many the policy permits
- reporting an outcome
- lookups, listings, and effect reads
- policy reads and writes
- webhook deliveries and their retries
- resolving an indeterminate effect

The reasoning is in DECISIONS D8: per-call pricing would charge the customer most on the day their
agent misbehaves, which is the day the product is doing its job. It also happens to match the cost
curve — a duplicate check is one indexed read.

---

## Plans

| | Free | Starter | Scale |
|---|---|---|---|
| Price | $0 | $19/mo | $99/mo |
| Included gated effects | 5,000 | 100,000 | 1,000,000 |
| Overage (prepaid credit) | $0.20 / 1,000 | $0.15 / 1,000 | $0.10 / 1,000 |
| Rate limit | 120/min | 600/min | 3,000/min |
| Retention | 7 days | 30 days | 90 days |
| API keys | 3 | 20 | 100 |
| Webhook endpoints | 1 | 5 | 25 |

Effective included rate: Starter $0.19 / 1,000; Scale $0.099 / 1,000.

Every plan has the full API, the full MCP surface, all three `on_indeterminate` modes, approval
gating, budgets, webhooks, and the complete audit trail. Paid plans buy **scale, retention, and
throughput** — not features withheld to force an upgrade. The free tier is meant to run a real
small workload, not to expire into a wall.

---

## Measured cost drivers

From `scripts/bench.ts` on darwin/arm64, Node v25.9.0, in-process HTTP against local Postgres
(excludes network round-trip):

| Operation | Mean | p50 | p95 | p99 |
|---|---|---|---|---|
| `begin` — new effect (billable) | 2.11 ms | 2.07 | 2.34 | 3.14 |
| `begin` — new effect, budget enforced | 3.41 ms | 3.36 | 3.64 | 4.27 |
| `begin` — duplicate replay (free) | 0.22 ms | 0.22 | 0.25 | 0.32 |
| `report` outcome (free) | 0.36 ms | 0.23 | 1.37 | 1.54 |

200 concurrent callers on one key: 16–19 ms total. On distinct keys: 15–16 ms.

The economically important line is the second-to-last: **the free path is ten times cheaper than
the billed path.** Pricing and cost point the same direction, which is what makes the free
operations genuinely free rather than cross-subsidised.

Storage per effect: roughly 400–700 bytes including indexes, held for `retention_days`.

---

## Cost model — assumptions, stated as assumptions

These are estimates for a small managed deployment. They are **not** quotes, and no vendor has
been contracted.

| Component | Assumption | Monthly |
|---|---|---|
| Managed Postgres | 2 vCPU / 4 GB, single primary with backups | $50 |
| Control plane | 2 small containers | $30 |
| Worker | 1 small container, always on | $15 |
| Logging and metrics | Modest retention | $20 |
| Domain, TLS, egress | Small | $10 |
| **Fixed baseline** | | **$125** |

Marginal cost per gated effect is dominated by database write throughput and storage. Taking the
measured 2.11 ms of database-bound work, a 2-vCPU primary sustains on the order of a few hundred
gated effects per second before contention, which is far above the volumes these plans describe.
Treating the baseline as covering the first ~10 M effects/month, marginal cost is well under
**$0.01 per 1,000** — an order of magnitude below the cheapest overage rate.

Payment processing (when a live provider is enabled): typically ~2.9% + $0.30 per transaction.
This is why credit is sold in $10 / $50 / $200 packs rather than charged per effect at $0.0002 —
per-effect card charging is arithmetically impossible, not merely inconvenient.

---

## Scenarios — illustrations, not forecasts

Constructed to show how the model behaves at different shapes of usage. They assume customers
exist; nothing here predicts that they will.

**Scenario A — 40 free, 8 Starter, 1 Scale**
Revenue $251/mo. Free-tier ceiling 200,000 effects. Fixed cost $125. Gross margin ≈ $126 (50%).
Free usage is ~4% of the paid volume and is not the constraint.

**Scenario B — 200 free, 30 Starter, 5 Scale**
Revenue $1,065/mo. Free ceiling 1 M effects; paid included volume 8 M. Fixed cost still roughly
$125–200 at this scale. Gross margin ≈ 80%.

**Scenario C — one heavy Scale customer at 4 M effects/month**
$99 included + 3 M overage at $0.10/1,000 = $399/mo from one account. Marginal cost remains a
small fraction of that; database sizing becomes the first thing to revisit.

**Scenario D — free tier abused**
1,000 free workspaces each maxing 5 M effects total. That is the real exposure. Controls: signup
rate limiting (5/hour per IP), a hard 5,000-effect ceiling per workspace per month with no
automatic overage without prepaid credit, per-key rate limits, and 7-day retention capping
storage. A free workspace cannot generate unbounded cost without a human deciding to pay.

---

## Why free is a real plan

5,000 gated effects a month runs a genuine small production workload — not a demo. The purpose is
that an operator can integrate, run the complete core loop including the indeterminate-recovery
path, and see real value before any payment conversation. A tier that expires mid-integration
teaches the wrong thing about a product whose entire pitch is that it tells you the truth about
failure.

The upgrade trigger is honest and self-evident: volume, retention, or throughput. Nothing is
withheld to manufacture one.

---

## Billing status in this build

Stripe is implemented and verified in **test mode**. A real Checkout Session was created against
Stripe's API, a real `checkout.session.completed` event credited $10.00 through the signed webhook,
signed replays of that event were correctly suppressed, forged and stale signatures were refused,
and the credited balance was then spent on a gated effect at exactly the plan's overage rate.

Not yet exercised with a live-mode key, and refunds are not handled — a dashboard refund will not
claw back credit until `charge.refunded` is implemented. Both are recorded in KNOWN_LIMITATIONS.

Without Stripe credentials, the built-in test adapter runs instead: the same ledger, entitlement,
and idempotency logic, with no network call and no charge.
