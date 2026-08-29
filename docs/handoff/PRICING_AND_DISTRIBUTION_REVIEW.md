# Pricing, scalability, distribution, and market review

**Independent review. 2026-08-29.** Assessed against the repository at commit `bc9a8b9`.

This review does not defend the existing pricing because a previous pass produced it. Two of its
central conclusions overturn earlier decisions in `PRICING_AND_UNIT_ECONOMICS.md`.

Throughout, claims are marked **[V]** verified against the repository, **[I]** inferred by
reasoning, or **[U]** uncertain / outside what this repository can establish.

---

## 1. Capability verification

The pricing question depends on what actually works. Each claimed capability below was checked
against source, tests, or a live run.

| Capability | Status | Evidence |
|---|---|---|
| At-most-once gating under concurrency | **Verified and tested** | Unique index `effects_ident_idx`; 25-way race admits exactly one (`test/integration/concurrency.test.ts`) |
| Durable state machine, all 7 states | **Verified and tested** | `src/domain/effects.ts`; 18 tests in `test/integration/effects.test.ts` |
| Lease fencing against stalled workers | **Verified and tested** | `lease_token` regenerated per grant; stale token → `lease_lost` |
| `indeterminate` state + 3 policy modes | **Verified and tested** | `block` / `retry` / `probe` each covered |
| Recorded result replay | **Verified and tested** | `duplicate` returns stored `result` |
| Retry / cancel / timeout / recovery | **Verified and tested** | `resolveEffect`, `cancelEffect`, reaper sweep |
| Dead-letter for webhooks | **Verified and tested** | 4xx → `dead`; 5xx → backoff requeue |
| Multi-tenant isolation | **Verified and tested** | Cross-tenant read/report/cancel/resolve all `404`; foreign lease token rejected |
| Scoped credentials, HMAC-hashed | **Verified and tested** | `src/domain/auth.ts`; no plaintext recoverable |
| Usage ledger integrity | **Verified and tested** | Append-only, deduped on `(workspace_id, dedupe_key)`; ledger sums to balance |
| Included-volume + overage enforcement | **Verified and tested** | `src/domain/metering.ts:81,86` |
| Retention cap per plan | **Verified** | `src/api/routes/workspace.ts:233` |
| API-key and webhook-endpoint caps | **Verified** | `workspace.ts:153`, `workspace.ts:303` |
| **Per-plan rate limits** | **Not present** | See §2.1 — advertised but never enforced |
| Payment webhook verification | **Verified and tested** | HMAC over raw body, replay window; 4 forgery cases refused |
| Stripe checkout lifecycle | **Implemented, verified in test mode only** | Real session created; real event credited $10.00 |
| **Refunds / disputes** | **Not present** | No `charge.refunded` handler anywhere in `src/` |
| MCP: stdio + streamable HTTP | **Verified and tested** | Both transports; stdio tested by spawning a child process |
| MCP tool/manifest consistency | **Verified and tested** | Contract test asserts manifest = `/mcp/info` = `tools/list` |
| OpenAPI accuracy | **Verified and tested** | Every documented path probed for reachability |
| **Remote MCP OAuth / DCR** | **Not present** | Static bearer only — see §6.2 |
| Latency measurement | **Verified, single machine** | 2.14 ms new / 1.58 ms duplicate; no network hop. Earlier figures were invalid — see VALIDATION_REPORT correction |
| **Deployment** | **Not present** | `PUBLIC_URL=http://localhost:8787` |
| **Product analytics** | **Not present** | No instrumentation; activation and retention are unmeasurable |
| **Failure-mode contract** | **Not present** | Nothing documents what an agent should do when the service is unreachable |
| Observability | **Partial** | Structured logs, `/healthz`, `/readyz`. No metrics export, no alerting |
| Availability posture | **Single point of failure** | Single-region, single-primary, no failover (`KNOWN_LIMITATIONS` §4) |

### Is the agent-facing differentiation real?

**Yes, technically.** [V] The `indeterminate` state, fencing tokens, and three-phase budget
reservation are correct solutions to genuinely subtle distributed-systems problems. The
concurrency tests demonstrate behaviour that naive implementations get wrong.

**But the commercial differentiation is weaker than the technical differentiation.** [I] A crude
version — a Postgres table with a unique constraint — is perhaps 100 lines. What is hard is
everything after: lease expiry, fencing, the refusal to guess at unknown outcomes, atomic budget
reservation across scopes. A buyer who has not yet been burned will price the crude version, not
the correct one.

This is an insurance-shaped product: **low perceived value before the incident, high after.** That
observation drives most of what follows.

---

## 2. Defects material to pricing

### 2.1 Per-plan rate limits are advertised but not enforced — [V]

The plan table, `/v1/billing/plans`, `/v1/workspace`, and the agent manifest all publish
`rate_limit_per_minute` as 120 / 600 / 3,000 by plan. The only enforcement point is:

```ts
// src/api/app.ts:102
max: config.rateLimitPerMinute,     // one global env value, default 600
```

The plan is never consulted. The comment at `app.ts:209` reads "Per-plan rate limiting layered on
top of the global default", but the hook beneath it only pre-authenticates the request; it sets no
limit. Consequences:

- A Free workspace receives 600/min, not the published 120/min — under-restricted.
- A Scale customer receives 600/min, not the published 3,000/min — **paying for throughput that is
  not delivered.**

Compounding this, `KNOWN_LIMITATIONS` §2 records that the limiter's store is per-process, so even
the global number multiplies by instance count.

**This is the one defect that makes charging money today indefensible.** Publishing a price for a
quantified entitlement that the code does not deliver is a misrepresentation, independent of
intent.

### 2.2 No refund or dispute handling — [V]

Zero matches for `charge.refunded` or `dispute` in `src/`. A refund issued in Stripe returns the
customer's money and leaves their credit balance intact. A ledger `adjustment` kind exists but
there is no route or console action to apply it, so the correction is a manual database edit.

At $10–$200 pack sizes the absolute exposure is small, but it is an unbounded manual process
attached to every refund request.

### 2.3 No product analytics — [V]

No instrumentation of any kind. Every threshold this review would normally recommend for a
price-change decision — activation rate, time to first successful workflow, repeat usage, cohort
retention — **is currently unmeasurable.** Section 6 of the memo defines those thresholds anyway,
but they cannot be evaluated until instrumentation exists.

### 2.4 Free-tier ceiling is not enforceable per person — [V]

Signup requires only a name and an email. There is no email verification, and `owner_email` carries
a plain index, not a `UNIQUE` constraint (`001_init.sql:26`). Signup is limited to 5/hour per IP,
so one address can mint ~120 workspaces per day, each with a full free allowance.

The mitigating fact is that the exposure is cheap: even 25,000 free workspaces running at the
current cap costs roughly **$200/month** of infrastructure [I]. This is a hygiene problem, not a
solvency problem.

### 2.5 No failure-mode contract for a critical-path dependency — [V]

AJBS sits in front of every side effect an agent performs. Nothing in the docs, examples, or code
tells an operator what an agent should do when the service is unreachable. The two options —
**fail-open** (act without the gate, risking duplicates) and **fail-closed** (refuse to act,
halting the agent) — are a policy decision that belongs to the customer and must be presented
explicitly.

Combined with a single-region, single-primary database with no failover, this is the objection a
careful buyer will raise first: *"you are selling me reliability, from an architecture with a
single point of failure, and you have not told me what happens to my agents when you go down."*

---

## 3. Are the current tiers correct?

### 3.1 The volume ladder does not step — [V]

| Plan | Included | Daily equivalent |
|---|---:|---:|
| Free | 5,000/mo | 164/day |
| Starter $19 | 100,000/mo | 3,289/day |
| Scale $99 | 1,000,000/mo | 32,895/day |

Mapped onto plausible operator profiles [I]:

| Profile | Effects/mo | Plan | Tier utilisation |
|---|---:|---|---:|
| Solo builder, 1 agent, 20/day | 608 | Free | 12.2% |
| Small team, 5 agents, 50/day each | 7,600 | Starter $19 | 7.6% |
| Production SaaS, 30 agents, 100/day each | 91,200 | Starter $19 | 91.2% |
| Heavy fleet, 200 agents, 200/day each | 1,216,000 | Scale $99 | 121.6% |

**A single $19 price covers everything from 5,001 to 100,000 effects — a 20× usage range.** Revenue
per customer is effectively pinned at $19 regardless of how much value they extract. Overage never
triggers; Scale is reached only by an operator running 33,000 gated side effects per day, which is
a large production fleet.

The practical consequence: **the account most likely to adopt early — a small team at a few
thousand effects per month — sits in Free forever, and the account that outgrows Free lands in a
tier it will not exhaust for years.** The ladder is calibrated for a business that does not exist
yet.

### 3.2 Are the prices too low or too high?

Per-unit, the included rates are **$0.19 / 1,000** (Starter) and **$0.099 / 1,000** (Scale).
Marginal cost to serve is roughly **$0.01 / 1,000** [I], so gross margin per unit is comfortable at
any of these numbers. Cost is not the binding constraint; willingness to pay is.

Against value: a single prevented duplicate charge on a $50 transaction repays a year of Starter.
On value alone the product is **underpriced by roughly an order of magnitude** [I].

Against trust: it is an undeployed, unproven, single-maintainer service with no SLA, proposing to
sit in the critical path of a customer's payments. That argues for a low, low-friction entry price.

**These two forces resolve as: keep the entry price modest, and fix the volume calibration
instead.** Price is not the problem. The included volume is.

### 3.3 Is three tiers the right count?

No. [I] Three tiers assert knowledge of three distinct segments. With zero users there is no
evidence for one segment, let alone three. Scale exists to serve a customer profile nobody has
observed. It should be removed and replaced by a stated contact path, which promises nothing the
product cannot currently deliver.

---

## 4. Recommended pricing structure

### 4.1 The meter stays

**One unit: a gated effect** — the first `begin` for a given `(effect_type, idempotency_key)`.

This is correct and should not change:

- It is the only value the backend can measure without trusting the client. [V]
- `estimated_cost_micros` is caller-supplied and therefore unusable for billing — a client could
  understate it. Its exclusion from metering is correct. [V]
- Metering only newly-created effects means retries, duplicates, and reports are free, so the
  customer is never billed more on the day their agent misbehaves. The duplicate path is also
  cheaper to serve — **1.58 ms against 2.14 ms**, about 26% — so price and cost point the same
  way, though less dramatically than an earlier, invalid measurement suggested. [V]

Alternatives considered and rejected: execution time (we execute nothing), worker compute (none),
callback deliveries (a fraction of effects, and free to serve), seats (agents are not seats),
per-effect-type (encourages bundling unrelated actions, which breaks policy semantics).

### 4.2 Recalibrated ladder

| Plan | Price | Included | Overage |
|---|---:|---:|---|
| Free | $0 | 1,000/mo | none — hard stop |
| Pro | $29/mo | 25,000/mo | $1.50 / 1,000 from prepaid credit |
| Custom | contact | above 250,000/mo | negotiated |

Same profiles under this structure:

| Profile | Effects/mo | Bill |
|---|---:|---:|
| Solo builder | 608 | $0 |
| Small team | 7,600 | $29.00 |
| Production SaaS | 91,200 | **$128.30** |
| Heavy fleet | 1,216,000 | Custom (list would be $1,815) |

Revenue now tracks value delivered. The production account paying $128 rather than $19 is the
single largest change this review recommends.

The included rate ($1.16/1,000) and overage rate ($1.50/1,000) are close to parity — deliberately.
Overage is not a penalty and not a discount; it is the same product at roughly the same price.

### 4.3 Free tier: 1,000/month

Reduced from 5,000. [I] 1,000 gated effects is ample to integrate, run the full core loop, exercise
all three `on_indeterminate` modes, and operate a hobby agent — retries and duplicates are free, so
a test suite hammering one key consumes a single unit. It is **not** enough to run a business
process, which is exactly where the line belongs.

Free must be a hard stop with no automatic overage. An account that exhausts it keeps duplicate
suppression and replay working — cutting those off over a billing state would cause the precise
duplicate the product exists to prevent. This behaviour already exists and is tested. [V]

### 4.4 Credit pack sizes should change

| Pack | Processing fee (2.9% + $0.30) | Effective cost |
|---|---:|---:|
| $10 (current) | $0.59 | **5.90%** |
| $50 (current) | $1.75 | 3.50% |
| $200 (current) | $6.10 | 3.05% |

The $10 pack loses nearly 6% to processing. Recommend **$25 / $100 / $500**, which caps processing
at ~3.9% [I]. Subscription processing on $29/mo is $1.14, or 3.93%.

---

## 5. Alternatives and competitive position

Comparisons are structural. No competitor pricing is cited, because none was verified. [U]

| Alternative | Why it is cheaper or easier | Where AJBS is weaker | Where AJBS is decisively better |
|---|---|---|---|
| Postgres/Redis table with a unique key | Free, in-house, no new dependency | No vendor risk, no critical-path third party | Lease expiry, fencing, `indeterminate`, budgets, audit — the parts naive versions get wrong |
| Durable workflow engines | Mature, funded, proven at scale | Vastly more capable; real HA | No rewrite required; AJBS wraps existing code with two calls |
| Serverless queues | Cheap, managed, trusted | Operationally proven; SLA-backed | Queues deliver work; they do not answer "did this already happen?" |
| Background-job frameworks | Free, familiar | Ecosystem, docs, community | In-process only — cannot answer across processes, machines, or model providers |
| Webhook relays | Simple, cheap | Narrower problem, better solved | Different problem entirely |
| Vendor idempotency keys | Free where offered | Native to the vendor | Works for vendors that offer nothing — SMTP, Slack, git, internal APIs |
| Agent framework memory | Bundled | Integrated with the agent loop | Survives process death; framework memory does not |

**The honest competitive summary:** AJBS is decisively better at exactly one thing — knowing, across
process and machine boundaries, whether a side effect already happened, and refusing to guess when
it cannot tell. That is a real and narrow wedge. It is not yet backed by the operational maturity
that would let it charge a premium as critical-path infrastructure.

---

## 6. Discoverability

### 6.1 What is genuinely built — [V]

- Streamable-HTTP MCP at `POST /mcp`, stateless, per-request authorised
- stdio MCP server for locally spawned clients
- 7 tools with strict input schemas and model-directed descriptions
- Capability manifest at `/.well-known/agent-manifest.json`, including an explicit "does not" list
- `llms.txt`, accurate OpenAPI 3.1, contract tests preventing drift between all three

This is a genuinely good discoverability surface. It is also, currently, **serving only from
`localhost`.**

### 6.2 The OAuth gap constrains distribution — [V]

The remote MCP endpoint authenticates with a static bearer API key. There is no OAuth 2.1
authorization-server metadata and no dynamic client registration.

| Integration path | Works today? | Requirement |
|---|---|---|
| Claude Code, Cursor, Claude Desktop (stdio or HTTP with pasted key) | **Yes** [V] | Operator pastes a key into a config file |
| Custom agent runtimes, OpenAI-compatible tool loops | **Yes** [V] | Developer writes the tool definition; REST or MCP |
| Generic MCP clients over HTTP | **Yes** [V] | Bearer token in the header |
| One-click connector directories that require OAuth | **No** [V/U] | Needs OAuth 2.1 + DCR; platform requirements vary and change — verify before relying |
| `npx`-installable stdio server | **No** [V] | `package.json` is `"private": true`; nothing published |

**No agent discovers this service automatically.** In every path above, a human operator installs
and authorises it. The manifest is honest about this — the stdio note already says "Not yet
published to npm". That honesty should be preserved.

### 6.3 First five discoverability actions, by impact over effort

1. **Deploy to a stable public HTTPS URL and set `PUBLIC_URL`.** Unblocks everything else; the
   manifest and `llms.txt` currently emit `localhost` URLs.
2. **Publish the stdio server to npm.** Turns every config example from a filesystem path into a
   copy-pasteable `npx` line. Low effort, high friction reduction.
3. **Add OAuth 2.1 + dynamic client registration to `/mcp`.** The single change that opens
   OAuth-gated connector directories.
4. **Submit to the official MCP registry** once 1 and 2 are done. [U] Registry mechanics and
   acceptance criteria change; confirm current requirements at submission time.
5. **Write the failure-mode contract and one technical article on duplicate-execution
   postmortems.** The contract removes the top adoption objection; the article is the demand
   generator, because it addresses the moment a buyer discovers they need this.

---

## 7. Commitment terms

| Term | Recommendation | Reasoning |
|---|---|---|
| Monthly | **Offer — the only option at launch** | Matches a buyer's trust level in an unproven critical-path service. Cash flow is irrelevant at this scale |
| 3-month | **Do not offer yet** | Procurement friction with no meaningful cash benefit at $29 ARPA. Adds a refund policy to maintain for ~$87 |
| 6-month | **Do not offer yet** | Same, plus a longer window in which the product may change materially |
| Annual | **Do not offer until retention is proven** | Selling a year of an unproven dependency invites refund requests and creates deferred-revenue obligations. Revisit after ≥6 months of cohort data. Then 2 months free (~17%) is a fair, conventional discount |

**Prepaid credit should not expire while an account is active.** Expiring credit is a poor look for
a trust-dependent product and creates consumer-protection exposure in some jurisdictions [U]. The
deferred-revenue liability at these amounts is negligible.

---

## 8. Scenario economics

Calculations, not forecasts. They assume customers exist; nothing here predicts that they will.
Customer acquisition cost, taxes, support time, and chargebacks are **excluded** and would reduce
every net figure.

### Cost model — assumptions, stated as assumptions [I]

| Component | Conservative | Base | Strong |
|---|---:|---:|---:|
| Managed Postgres, control plane, worker, logging, domain | $125 | $200 | $420 |
| Variable infrastructure (~$8 per million effects) | included | included | included |

### Scenarios under the recommended structure

| Scenario | Free | Pro | Custom | Monthly gross | Weekly | Daily | Annualised | Gross margin |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Conservative | 60 | 8 | 0 | $277 | $64 | $9 | $3,324 | **50.6%** |
| Base | 250 | 35 | 1 | $1,924 | $444 | $63 | $23,093 | **85.5%** |
| Strong | 900 | 140 | 4 | $9,820 | $2,268 | $323 | $117,840 | **91.7%** |

Overage contributes 16% / 24% / 34% of gross across the three scenarios — evidence that the
recalibrated ladder actually steps, which the current one does not.

The Conservative scenario is the important one: at 8 paying customers the business is **barely above
its fixed costs**. Margin percentage is flattering; absolute margin is $140/month. This is a
structural property of low-ARPA infrastructure and argues for patience rather than for raising
prices.

### Free-tier cost ceiling at a 1,000/month cap [I]

| Free workspaces at cap | Effects/mo | Infra cost |
|---:|---:|---:|
| 500 | 0.5M | ~$4 |
| 5,000 | 5.0M | ~$40 |
| 25,000 | 25.0M | ~$200 |

The free tier is cheap enough that abuse is an operational annoyance, not a financial risk.

---

## 9. What must be true before raising prices

Objective checkpoints. These are **operating targets, not market facts**, and none can be evaluated
until analytics exist (§2.3).

| Metric | Target before any price increase | Why |
|---|---|---|
| Activation rate | ≥40% of signups reach a first `execute` → `report` cycle | Below this, onboarding is the problem, not price |
| Time to first successful workflow | ≤15 minutes median | The product's claim is easy integration |
| Repeat usage | ≥50% of activated workspaces active in week 2 | Distinguishes evaluation from adoption |
| Retention | ≥70% of paid accounts at month 3 | Below this, annual plans and price rises both fail |
| Cost to serve | <15% of revenue | Recompute from real usage, not the estimates above |
| Gross margin | ≥75% at ≥20 paid accounts | Confirms the model |
| Reliability | ≥99.9% measured over 90 days, published | Prerequisite to charging for reliability |
| Support burden | <1 hour per paid account per month | Determines whether higher tiers are deliverable |
| Abuse rate | <5% of free signups flagged | Validates the free cap |
| Differentiation evidence | ≥3 customers who can name a specific duplicate prevented | Converts the insurance pitch into a case study |
| Willingness to pay | ≥5 unsolicited overage payments | The strongest available signal |

---

## 9b. Implementation status

Acted on immediately after the review was accepted:

| Item | Status |
|---|---|
| P0 — enforce rate limits per plan | **Done.** Limiter reads the workspace plan via a 60s per-key cache; 4 tests, including one asserting the published limit equals the enforced limit |
| P0 — failure-mode contract | **Done.** `docs/FAILURE_MODES.md`: fail-open vs fail-closed, client requirements, partial-failure matrix, honest availability posture |
| P1 — recalibrate plans | **Done.** Free 1,000; Pro $29 / 25,000 / $1.50 per 1,000; `starter` and `scale` collapsed into `pro` by migration `002` |
| P2 — credit pack sizes | **Done.** $25 / $100 / $500; smallest pack now loses 3.9% to processing, not 5.9% |
| P0 — deploy publicly | **Owner action.** Needs hosting credentials |
| P1 — product analytics | **Not started.** Blocks every threshold in §6 |
| P1 — `charge.refunded` | **Not started** |
| P2 — email verification, `UNIQUE` on `owner_email` | **Not started** |
| P3 — publish stdio to npm, OAuth 2.1 on `/mcp` | **Owner action** (npm account) / not started |

## 10. Conclusion

The product is technically sound and genuinely differentiated on a narrow, real problem. The
pricing attached to it is calibrated for a business that does not exist: a single $19 price spans a
20× usage range, the top tier addresses a customer profile nobody has observed, and one advertised
entitlement is not delivered by the code at all.

The correct sequence is: **deploy, launch free, instrument, then price.** Nothing about the pricing
recommendation here should be implemented before there is a deployed instance serving external
traffic, because every number in it is reasoning rather than evidence, and the repository currently
contains no usage data against which to check it.
