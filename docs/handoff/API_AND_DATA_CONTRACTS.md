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
| `estimated_cost_micros` | int ≥0 | no | External cost. Enforced as a ceiling; never collected |
| `agent_id`, `run_id` | string ≤128 | no | Operator visibility |
| `request_summary` | object | no | Small non-sensitive metadata shown in the console |
| `lease_seconds` | int 5–3600 | no | Clamped to the policy maximum |

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
| `ratchet_check_effect` | `effects:read` | yes |
| `ratchet_resolve_effect` | `effects:admin` | no |
| `ratchet_list_effects` | `effects:read` | yes |
| `ratchet_get_policy` | `policies:read` | yes |
| `ratchet_usage` | `workspace:read` | yes |

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
