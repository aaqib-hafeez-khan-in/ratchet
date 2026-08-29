# Pricing and unit economics

> **Superseded in part (2026-08-29).** The three-tier ladder described below was replaced after
> [`PRICING_AND_DISTRIBUTION_REVIEW.md`](PRICING_AND_DISTRIBUTION_REVIEW.md) found it priced a 20x
> usage range at a single number and advertised a rate limit the code did not enforce. Current
> plans are Free (1,000/mo) and Pro ($29/mo, 25,000 included, $1.50/1,000 overage), with custom
> pricing above 250,000/mo. The cost model, meter definition, and free-tier reasoning below remain
> accurate; the plan table does not. `src/domain/plans.ts` is the source of truth.

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

| | Free | Pro |
|---|---|---|
| Price | $0 | $29/mo |
| Included gated effects | 1,000 | 25,000 |
| Overage (prepaid credit) | $1.50 / 1,000 | $1.50 / 1,000 |
| Rate limit (enforced per plan) | 60/min | 600/min |
| Retention | 7 days | 30 days |
| API keys | 3 | 20 |
| Webhook endpoints | 1 | 5 |

Above 250,000 effects/month, list pricing stops applying — see `CUSTOM_PRICING_THRESHOLD`.

Effective included rate on Pro: $1.16 / 1,000, with overage at $1.50 / 1,000 — close to parity on
purpose, so overage is neither a penalty nor a discount.

Every plan has the full API, the full MCP surface, all three `on_indeterminate` modes, approval
gating, budgets, webhooks, and the complete audit trail. Pro buys **volume, retention, and
throughput** — not features withheld to force an upgrade.

> **Scenario projections moved.** The scenario tables that were here modelled the superseded
> three-tier ladder. Current scenarios, with account mix rather than a blended average, are in
> [`PRICING_AND_DISTRIBUTION_REVIEW.md`](PRICING_AND_DISTRIBUTION_REVIEW.md) §8.

## Why free is a real plan

1,000 gated effects a month is enough to integrate, exercise all three `on_indeterminate` modes,
run the full indeterminate-recovery path, and operate a hobby agent — retries and duplicates are
free, so a test suite hammering one key costs a single unit. It is deliberately **not** enough to
run a business process, which is exactly where the line belongs.

The earlier 5,000 figure was too generous in a specific way: it absorbed the entire realistic early
market, so the accounts most likely to adopt would never have had a reason to upgrade.

The upgrade trigger is arithmetic, not a wall. Free stops at its allowance unless prepaid credit is
loaded, and past roughly 19,300 effects a month Pro costs less than paying credit on Free. Nothing
is withheld to manufacture an upgrade.

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
