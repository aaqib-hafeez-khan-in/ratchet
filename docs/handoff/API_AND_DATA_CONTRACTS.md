# API and data contracts

The authoritative machine-readable contract is `/openapi.json`, generated from the same JSON
Schemas the routes validate against (`src/api/schemas.ts`), so it cannot drift from the
implementation. This document is the human-readable companion.

Base URL: `{PUBLIC_URL}/v1` · Auth: `Authorization: Bearer rk_<env>_<prefix>_<secret>`
(or `X-API-Key`) · Wire format: `snake_case` · Money: integer micro-USD (1e-6 USD).

---

## Scopes

| Scope | Grants |
|---|---|
| `effects:begin` | Request permission to perform an effect |
| `effects:report` | Close out a leased effect |
| `effects:read` | Read effect records and results |
| `effects:admin` | Resolve, cancel, approve |
| `policies:read` / `policies:write` | Read / change effect-type policy |
| `workspace:read` | Plan, balance, usage, keys, webhooks, ledger, audit |

An executing agent needs only `effects:begin` and `effects:report`.

---

## Endpoints

### `POST /v1/effects/begin` — the gate

The only metered call, and only when it creates a new effect record.

| Field | Type | Required | Notes |
|---|---|---|---|
| `effect_type` | string | yes | `^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$`. Policy is per type |
| `idempotency_key` | string ≤255 | yes | Deterministic, derived from the work itself |
| `payload` | any | no | Only a SHA-256 fingerprint is stored |
| `estimated_cost_micros` | int 0–1e13 | no | External cost, micro-USD. Enforced as a ceiling; never collected. **Raised from 1e9 ($1,000) on 2 Sep 2026** — that bound predated any use case and excluded every payout, wire and sweep the product argues for |
| `agent_id`, `run_id` | string ≤128 | no | Operator visibility |
| `request_summary` | object | no | Small non-sensitive metadata shown in the console |
| `lease_seconds` | int 5–3600 | no | Clamped to the policy maximum |
| `dimensions` | object ≤8 | no | Axes to count this effect against, e.g. `{"counterparty":"acct_1"}`. Only an HMAC of each value is stored |

Response:

| Field | Present when |
|---|---|
| `decision` | always — `execute` · `duplicate` · `in_flight` · `blocked` · `approval_required` · `denied` |
| `effect_id`, `effect_type`, `idempotency_key`, `state`, `attempt` | always |
| `lease_token`, `lease_expires_at` | `execute` only |
| `result` | `duplicate` only — the recorded outcome to replay |
| `retry_after_seconds` | `in_flight`, `approval_required` |
| `prior_attempt` | `blocked`, and a retry granted after an indeterminate attempt |
| `reason` | every non-`execute` decision |
| `budget_warning` | a ceiling exists for this type and the call declared no cost |
| `integration_warning` | this workspace has never reported an outcome and ≥3 effects sit unreported |
| `billing.metered`, `billing.included_remaining` | always |

**A lease is issued only with `execute`.** No other decision carries one — asserted in tests.

**`integration_warning` costs no round trip.** It rides the workspace `FOR UPDATE` that the
new-effect path already takes, as a `CASE WHEN EXISTS (a settled effect) THEN NULL ELSE
count(unreported)`. Both branches use `effects_state_idx`; a workspace that has ever reported
short-circuits on the first index row and never runs the count, and the duplicate path — which
does not take the workspace lock — never computes it at all. One successful report disables it
for that workspace permanently, so it cannot become background noise for a working integration.
Threshold `UNREPORTED_WARN_AT = 3` in `src/domain/effects.ts`.

**Guidance text that names an endpoint is part of the contract.** `next_step.then` at signup,
the `blocked` reason, and `integration_warning` all name paths, and `report` and `resolve` are
addressed by effect **id** while `begin` is addressed by `effect_type` + `idempotency_key`.
Copying one shape into the other sends an already-stuck caller to a 404 — which happened three
times while writing these messages. `test/e2e/first-five-minutes.test.ts` extracts every `/v1/…`
path from what the service actually says and asserts each one resolves.

### `POST /v1/effects/{id}/report`

| Field | Type | Notes |
|---|---|---|
| `lease_token` | string | The fencing token from `begin` |
| `outcome` | `succeeded` \| `failed` | See the rule below |
| `result` | any | Replayed verbatim to duplicate callers. Capped at `MAX_RESULT_BYTES` |
| `failure_reason` | string ≤1024 | For `failed` |
| `actual_cost_micros` | int ≥0 | Reconciles the reservation |

**Report `failed` only when the effect provably did not reach the outside world.** If unsure,
report nothing: the lease lapses and the effect becomes `indeterminate`.

### `POST /v1/effects/{id}/resolve`

Settles an `indeterminate` (or `awaiting_approval`) effect after verifying reality.
`{ outcome: succeeded|failed|cancelled, evidence?, result? }`. `evidence` is stored in the audit
trail. Requires `effects:admin` or a console session.

### `POST /v1/effects/{id}/cancel`

Refused for `succeeded` (it already happened) and for `pending` (it may be executing right now —
wait for the lease to lapse, then resolve).

### `POST /v1/effects/{id}/approval`

`{ approve: boolean, note? }`. Approving lets the next `begin` obtain a lease; rejecting denies
the effect permanently.

### Reads

| Endpoint | Notes |
|---|---|
| `GET /v1/effects/{id}` | One record |
| `GET /v1/effects/lookup?effect_type=&idempotency_key=` | Free, never metered, never grants a lease |
| `GET /v1/effects?state=&effect_type=&run_id=&limit=` | Recent effects, newest first |

### Agent reliability

`GET /v1/agents?days=30` — agents seen in the window, busiest first.
`GET /v1/agents/{agentId}/reliability?days=30` — one agent's profile, `404` if this workspace
has never seen it.

**Console session or admin key only.** Deliberately not reachable with the narrow agent key:
every metric here is one an agent could flatter by doing less, and an agent that can read its own
grade can work out which signal to stop emitting. A test asserts the agent key is refused.

`agent_id` is caller-supplied and used for grouping and nothing else — it selects no policy,
grants no permission, changes no decision. A caller that lies about it mislabels only its own
statistics.

| Group | What it answers |
|---|---|
| `reporting` | Of the effects that concluded, how many were reported vs left `indeterminate`. The headline: what the outside world cannot tell you |
| `decisions` | What `begin` answered, counted from **receipts** — `duplicate`, `in_flight` and `blocked` create no effect row, so retry behaviour is invisible in `effects` |
| `keys` | Identical work (same `effect_type` + payload fingerprint) arriving under several idempotency keys — the tell of an agent minting a key per attempt. `excess_keys` counts the keys beyond one per piece of work, i.e. the calls that looked new to the gate |
| `cost` | Declared estimate against actual spend |
| `lease` | Median and p95 seconds between taking permission and reporting |
| `concerns` | Plain sentences, worst first, only where a threshold is crossed with volume behind it |

**There is no composite score, on purpose.** A blended number hides the mechanism — an operator
learns their agent is "72", not that it stopped reporting outcomes last Tuesday — and the
cheapest way to raise one is usually to stop emitting whatever drags it down.

**Rates below a volume floor return `null`,** not a confident-looking number computed from four
samples (`FLOOR = 20` for rates, `SAMPLE_FLOOR = 5` for cost and lease medians, both in
`src/domain/agent-quality.ts`).

**Key churn is a hint, not a verdict.** A deliberate repeat looks identical from here: the same
reminder sent again next week is the same payload under a new key, and that is correct usage.
Which is why it is reported as a rate over enough volume to mean something, and never fires on a
single piece of repeated work.

**The churn floor is on volume observed, not on distinct work — found by running real traffic.**
The first version gated the rate on the number of distinct work items, and an agent doing six
kinds of thing repeatedly under a fresh UUID key each time — 24 calls, 6 payloads, 24 keys, which
defeats the gate completely — produced no concern at all, because six is below the floor. That is
a normal shape for an agent and the shape where churn matters most. The rate is now gated on
`volume.effects >= 20` with `distinctWork >= 2`, so one deliberately repeated thing still cannot
trigger it alone.

**The listing returns `concluded` as well as `effects`.** The console prints the sample size
beside "not enough yet", and effects still in flight have concluded nothing — quoting the effect
count there would name a sample that does not exist.

Two columns exist for this, both written by the UPDATE that grants a lease, so neither costs a
round trip (migration 032):

- `effects.lease_granted_at` — `created_at` is when the effect was first asked about, which for a
  retried effect can be hours before permission was taken.
- `effects.declared_micros` — `reserved_micros` is zeroed on report, correctly, since it is a live
  reservation. That erased the only record of the estimate, so "does this agent know what its
  actions cost" was unanswerable after the fact.

Both are `NULL`/`0` for effects begun before the migration. The endpoint reports how many effects
it could actually measure rather than averaging over rows that never carried the field.

### Dimensions and per-destination ceilings

A ceiling could be scoped to a workspace, an API key or an effect type. None of those is a
**destination**, so twenty distinct $500 refunds to one bank account passed every check. A
destination lives in the payload, and Ratchet never stores payloads.

**Counting does not require reading.** A caller declares `dimensions` on begin; Ratchet stores
`HMAC(AUTH_SECRET, "dim:v1:<workspace>:<name>:<value>")` truncated to 128 bits, as
`dim:<name>:<32 hex>`. It cannot say who the counterparty is and cannot reverse the value — and
because the workspace id is inside the MAC, the same account in two workspaces is two unrelated
identifiers. It can still count.

Policy gains two fields:

```
PUT /v1/policies/payment.refund
{ "required_dimensions": ["counterparty"],
  "dimension_limits": { "counterparty": { "daily_micros": 200000000, "daily_count": 20 } } }
```

`daily_count` applies to effects that declare **no cost at all**, which is what makes it usable
for outbound messaging — "no more than five to this address per day" has no monetary component.
A velocity refusal is `budget_exceeded` with `count_limit`/`count_used` in the detail and a
message that says so, because a caller told "spend budget" while having declared nothing would go
looking for money that was never the problem.

**A declaration tightens and never loosens.** This is the whole reason CLAUDE.md §6 tolerates
caller-supplied text selecting a ceiling, and it is asserted by tests:

- Declaring adds a limit; the workspace, key and type limits still apply. A generous
  `dimension_limits` entry cannot override a tighter `daily_budget_micros`.
- Omitting a dimension in `required_dimensions` is a `400 dimension_required`, not a bypass —
  a 400 rather than a `denied` decision so a caller bug does not burn the idempotency key.
- Lying puts the effect in a different bucket and grants nothing extra. The vendor knows the
  real destination, so `POST /v1/reconcile` is where a lie surfaces.
- A **retry cannot move buckets.** Ceilings are computed from the effect's stored dimensions,
  never from the retry's body.

**Counts follow at-most-once, money follows reality.** Three attempts at one payment is one
payment against a velocity ceiling — a retry releases its count and takes it again. But a
lease that expires unreported, or an effect that is resolved or cancelled, keeps its count:
returning it would make crashing the agent, or cancelling, the cheapest way past the ceiling.
Money is reconciled to the reported actual, so under-declaring cannot walk past a spend ceiling.

`effects.reserved_dimension_scopes` records what a lease actually reserved against, so a release
reverses exactly what was taken even if policy is edited in between.

### Fan-out and fan-in

`GET /v1/analysis/fan?days=30&dimension=counterparty` — console session or admin key.

**Fan-out is measured by novelty, not width.** A payroll run reaches five hundred counterparties
every month and is the healthiest thing in the system, so cardinality alone is useless as a
signal and reporting on it would bury an operator in alerts about their own operations. What
separates payroll from a disbursement into fresh accounts is how many destinations are **new**.
Reported per `run_id` and per `agent_id`, only when the group cleared `FANOUT_FLOOR = 20` distinct
counterparties **and** at least `NEW_SHARE_AT = 0.8` of them were unseen. `high` needs ≥95% new
and ≥40 of them.

**"Seen before" looks back `PRIOR_WINDOWS = 4` windows, not for ever.** Unbounded history means a
check that gets slower every day the service runs, and a counterparty last paid three years ago
is new for this purpose anyway.

**Fan-in is the half nothing else can see.** One counterparty collecting from `FANIN_FLOOR = 3` or
more distinct agents. Each agent is inside every limit it has, because no per-agent ceiling can
look across agents — only something in front of all of them can.

Both work entirely over the blinded dimension: the analysis counts how many distinct
counterparties there are and whether they have been seen, without being able to name one. A test
asserts no raw value can appear in the response.

**Neither is a verdict.** A first payroll run is 100% new counterparties and is indistinguishable
from the thing this finds. The `detail` text says so, and the OpenAPI description does too — a
test asserts both.

The `dimension` parameter is a bound query parameter constrained by pattern; the grouping column
is chosen from a fixed pair inside the domain and never built from caller input. A test posts SQL
through `dimension` and asserts a 400 with the table intact.

### Structuring analysis

`GET /v1/analysis/structuring?days=30` — console session or admin key, never the agent key.

**A read, not a gate.** Structuring is a property of a distribution, not of any one call: a
single payment at $9,800 is ordinary and refusing it would be wrong. Twenty-three of them
against a $10,000 line is not, and only something holding the thresholds can see the difference.

**Method — a bunching comparison, not a model.** Two adjacent bands of equal width below the
threshold:

```
   control band          hug band
 [0.80T ......... 0.90T)[0.90T ......... T)
```

Real amounts do not spike in the final tenth before a number somebody is avoiding, so an excess
in the hug band is the signal. Reported as `excess_ratio = just_below / max(control, 1)` — the
control floored at one, so an empty control band is the strongest possible reading rather than a
division by zero. Constants in `src/domain/structuring.ts`: `FLOOR = 10` in the hug band before
any ratio is computed, `REPORT_AT = 3`, `SEVERE_AT = 6`. **Equal band widths are load-bearing** —
comparing a wide band to a narrow one would manufacture an excess, and a test asserts it.

**`effect_policies.structuring_threshold_micros` enforces nothing.** It is the line to measure
against, and it exists because the line that actually gets hugged is usually not one Ratchet
owns: a reporting threshold, an internal review limit. Knowing the amounts is enough; owning the
threshold is not required. Null falls back to `max_cost_micros`, since a ceiling that does refuse
is a line worth hugging too. A test asserts an effect far above the watch line is still
permitted.

**It is a hint, not a verdict**, and the wording in `detail` says so. A cap produces the same
bunching honestly — told they may spend up to $10,000, people spend $9,999 — and what separates
that from structuring is intent, which is not visible here. `concentrated_in` reports the blinded
counterparties the bunching sits on, because spread across many destinations it is usually a cap
and at one destination it is not. Never the raw value; a test asserts the account number cannot
appear in the report.

`without_threshold` lists effect types with no line configured. Reported rather than skipped:
nothing-found and nothing-configured look identical in an empty response and are very different
answers.

### Policies

`GET /v1/policies` · `GET|PUT|DELETE /v1/policies/{effect_type}`

| Field | Values | Default | Meaning |
|---|---|---|---|
| `mode` | `allow` \| `require_approval` \| `deny` | `allow` | Whether the type may run |
| `on_indeterminate` | `block` \| `retry` \| `probe` | `block` | **The important one.** What a later caller may do after an unknown outcome |
| `lease_seconds` | 5–3600 | 60 | Time to report before going indeterminate |
| `max_attempts` | 1–50 | 3 | Attempt ceiling per key |
| `max_cost_micros` | int \| null | null | Per-effect cost ceiling |
| `daily_budget_micros` | int \| null | null | Daily external-spend ceiling for this type |
| `retention_days` | 1–400 | 7 | Bounded by plan |

An unconfigured effect type returns the defaults with `is_default: true`.

The rows above are the fields most people set. The rest — `require_cost`, `required_dimensions`
and `dimension_limits` (see *Dimensions*), `structuring_threshold_micros` (see *Structuring
analysis*), and `surge_per_hour` / `surge_multiplier` / `surge_action` / `surge_cooldown_seconds`
(see `CIRCUIT_BREAKER.md`) — carry their prose in the PUT body schema in
`src/api/routes/workspace.ts`, which is where `/openapi.json` gets it from.

**The reference table on `/docs` is pinned to that schema.** All four of the newest fields were
documented somewhere on the site and missing from the one table a reader consults to learn what a
policy accepts, which is a gap nobody notices, because every field looks documented from wherever
it *was* written up. `test/unit/policy-docs.test.ts` now diffs the emitted PUT body schema against
the field names in `web/docs.html` in both directions: a new policy field has to be explained on
the page, and the page cannot name a field the route would reject.

### Workspace, keys, webhooks, billing

| Endpoint | Purpose |
|---|---|
| `POST /v1/workspaces` | Signup. Returns the key **once**. Rate limited to 5/hour |
| `GET /v1/workspace` | Plan, balance, usage, today's external spend |
| `GET\|POST /v1/keys`, `DELETE /v1/keys/{id}` | Scoped keys; secrets never returned after creation |
| `POST /v1/console/signout` | Destroys the session cookie |
| `GET\|POST /v1/webhooks`, `DELETE /v1/webhooks/{id}` | Endpoints; signing secret returned once |
| `GET /v1/webhooks/deliveries` | Attempts, statuses, errors |
| `GET /v1/usage/ledger` | Immutable credit movements |
| `GET /v1/audit` | Audit trail |
| `GET /v1/billing/plans` | Public. States the meter and whether billing is live |
| `POST /v1/billing/checkout` | Starts a credit purchase |
| `POST /v1/billing/test/settle` | Test adapter only. Idempotent on `session_id` |
| `POST /v1/billing/webhook/stripe` | Signature-verified. Unauthenticated by design — the HMAC is the authentication |

### Meta

`GET /healthz` · `GET /readyz` (checks the database, returns latency) ·
`GET /.well-known/agent-manifest.json` · `GET /llms.txt` · `GET /openapi.json` · `GET /mcp/info`

---

## Errors

`{ "error": { "code", "message", "detail"? } }`. Branch on `code` — it is stable.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Schema validation failed; `detail.validation` locates it |
| 401 | `unauthorized` | Missing, malformed, revoked, or unknown key |
| 402 | `insufficient_credit` | Allowance exhausted, balance too low. Replays still work |
| 403 | `forbidden` | Missing scope (`detail.required`), or suspended workspace |
| 403 | `budget_exceeded` | A daily ceiling would be breached; `detail` names the scope |
| 403 | `cost_ceiling_exceeded` | Declared cost exceeds the per-effect maximum |
| 404 | `not_found` | No such record **in this workspace** — never confirms it exists elsewhere |
| 409 | `idempotency_key_reuse` | Same key, different payload fingerprint |
| 409 | `lease_lost` | Your lease was superseded. Do not assume your work counted |
| 409 | `invalid_state` | Illegal transition from the current state |
| 409 | `retry_request` | Record changed concurrently; retry |
| 413 | `payload_too_large` | Body or result over the configured limit |
| 429 | `rate_limited` | `detail.retry_after_seconds` |
| 503 | `billing_unavailable` | No live payment provider configured |

5xx responses carry only `detail.request_id`. Internal detail never crosses the boundary —
asserted by a test that greps responses for stack frames, SQL, and connection strings.

---

## Webhooks

Events: `effect.succeeded` · `effect.failed` · `effect.indeterminate` ·
`effect.approval_required` · `effect.approved` · `effect.rejected` · `effect.denied` ·
`budget.exceeded`

Headers: `ratchet-delivery-id`, `ratchet-timestamp`, `ratchet-signature`, `idempotency-key`.

```
signature = HMAC-SHA256(secret, "{timestamp}.{delivery_id}.{raw_body}")
header    = "t={timestamp},v1={signature}"
```

Including the delivery id means a captured delivery cannot be replayed under a different id.
Verify against the **raw** body, compare in constant time, and reject stale timestamps.

Delivery: 5xx / 408 / 429 retry with exponential backoff and full jitter, capped at 30 minutes and
`WEBHOOK_MAX_ATTEMPTS`. Other 4xx and any 3xx are permanent and dead-letter immediately.
Redirects are never followed.

---

## MCP tools

`POST /mcp` (Streamable HTTP, stateless) or stdio. Protocol versions `2025-06-18`, `2025-03-26`,
`2024-11-05`.

| Tool | Scope | Read-only |
|---|---|---|
| `ratchet_begin_effect` | `effects:begin` | no |
| `ratchet_report_effect` | `effects:report` | no |
| `ratchet_get_effect` | `effects:read` | yes |
| `ratchet_resolve_effect` | `effects:admin` | no |
| `ratchet_list_effects` | `effects:read` | yes |
| `ratchet_get_policy` | `policies:read` | yes |
| `ratchet_get_usage` | `workspace:read` | yes |

Live schemas: `GET /mcp/info`. Every `ratchet_begin_effect` result carries `next_step`, which
begins with `STOP` for every decision other than `execute`.

---

## Data model

| Table | Purpose | Key constraints |
|---|---|---|
| `workspaces` | Tenant, plan, credit balance, period counter | — |
| `api_keys` | HMAC-hashed secrets, scopes, per-key budget | unique `prefix` |
| `effects` | **The state machine** | unique `(workspace_id, effect_type, idempotency_key)` — this is what enforces at-most-once |
| `effect_policies` | Per-type rules | PK `(workspace_id, effect_type)` |
| `spend_windows` | Daily external-spend rollups | PK `(workspace_id, scope, day)` |
| `ledger_entries` | Append-only credit movements | unique `(workspace_id, dedupe_key)` |
| `audit_events` | Immutable history | — |
| `webhook_endpoints` / `webhook_deliveries` | Delivery | unique `(endpoint_id, dedupe_key)` |
| `console_sessions` | Hashed session ids | — |
| `processed_payment_events` | Provider event dedupe | PK = provider event id |

Indexes worth knowing: `effects_lease_sweep_idx` is partial on `state = 'pending'`, so the
reaper's scan stays small regardless of table size; `effects_gc_idx` is partial on the complement.
