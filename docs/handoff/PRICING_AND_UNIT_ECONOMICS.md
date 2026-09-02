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

---

## Capability gating (2 Sep 2026)

Until now every plan limit was a **number** — effects, keys, webhooks, retention days,
requests per minute — and all of them were enforced. There was nothing a paid plan could
*do* that a free one could not, which is a reasonable thing for a paid plan to offer.

### The line, and why it is drawn there

**Nothing that prevents damage is behind a gate.** At-most-once, every policy mode,
indeterminate handling, surge containment, run budgets, recall, approvals, webhooks and the
audit trail are on the free plan and stay there.

Selling safety by the tier would make the product worse for the people least able to pay,
while the whole argument of the product is that the safe thing should be the easy thing. It
is also commercially self-defeating: free users are the ones who tell other people about a
gate that saved them.

What is gated is **evidence, recovery and scale** — what a team needs to run this in
production and prove it to somebody else, rather than what stops the bad outcome.

| Capability | Free | Pro | Scale | What it is |
|---|:--:|:--:|:--:|---|
| Reversible effect groups | – | ✓ | ✓ | Undo a half-finished unit of work |
| Signed receipts | – | ✓ | ✓ | Verify each decision without trusting us |
| Reconciliation | – | – | ✓ | Find real-world actions that bypassed the gate |

**Two things deliberately left open to everyone:**

- **`/usage/prevented`** — the report showing duplicates refused and what they would have
  cost. This is the product proving its own value, and it is the reason somebody upgrades.
  Putting it behind the upgrade is backwards.
- **`/.well-known/ratchet-receipt-key`** — the public key. Receipts are only worth anything
  if the person holding one can verify it, and they may not be a customer at all.

Receipts are still **written** for every workspace on every plan; they are part of the audit
chain and skipping them for some workspaces would break it. Pro gates *reading them back*.

### Nobody is demoted

Migration 029 adds `workspaces.legacy_capabilities` and sets it true for every row that
existed. Those workspaces keep everything they could already do, whatever their plan says,
for as long as they exist. The gate applies only to workspaces created after it.

This is the same failure email verification came one backfill away from making, when it
nearly dropped every existing customer from 1,000 effects to 100. A cutoff date would have
worked too; a flag is easier to reason about and impossible to get wrong by an hour.

### It cannot drift

`/v1/billing/plans` publishes the capability set, read from the same `PLANS` object the
route guards enforce, and the pricing page renders that rather than a typed-out table. A
test asserts the published set equals the enforced set for all three plans. A tier table
that disagrees with the code is the one kind of marketing copy that is also a broken promise.

### Overage: refused by default, topped up on request (2 Sep 2026)

Beyond the included allowance, spending draws on **prepaid credit**, and at a zero balance
the effect is **refused** — on every plan including Scale. That stays the default: nothing
is ever billed by surprise.

**Automatic top-up is the opt-in for customers who would rather not hit the wall at 3am.**
Below a threshold they choose, a credit pack they choose is bought from a card already on
file.

This is the only code in the repository that moves money with no human present, so the
guards are worth listing:

| Guard | Why |
|---|---|
| Off unless explicitly enabled | There is no default that charges anybody |
| A card must already be on file | We never collect card details for this |
| Unique index on `(workspace_id, trigger_key)` | At-most-once, enforced by the database — the same way the product enforces its own guarantee |
| Stripe idempotency key = the row id | A retried HTTP request cannot become a second charge |
| Hard cap of **3 charges a day** | A runaway loop drains an allowance, not a bank account |
| A decline **disables** and explains | Retrying a decline is how a card gets locked and the customer gets a fraud alert with our name on it |
| Threshold must be below the pack size | Otherwise every top-up immediately leaves the balance under the threshold again |
| Runs in the worker, never in `begin` | A network call inside the gate transaction would slow every request, and a rollback after a successful charge would take money for credit never granted |
| Credit granted by the **signed webhook** | One path creates money, and it is the idempotent one a human checkout already uses |
| Only a console session or admin key may enable it | An agent that could switch this on could fund its own overspending — the same refusal as an agent raising its own budget ceiling |

Tested at the level that matters: **eight concurrent claims produce exactly one charge**, and
a workspace with no card, a disabled setting, or a spent daily cap claims nothing at all.

**Not yet exercised against a live card**, which is stated here rather than assumed. The
charge path is `payment_intents` with `off_session` and `confirm`, and it has never taken
real money. Enabling it on a production workspace is deliberately a human action.

