# Assurance case

Why Ratchet's security requirements are met, and where they are not.

An assurance case is an argument, not a checklist, so this states what the system
must guarantee, what it is defending against, where the trust boundaries sit, and
what evidence supports each claim. Every claim below names the test or mechanism
that enforces it. Where something is not defended, it says so — a case that
claims more than it can support is worse than none.

Architecture: [docs/handoff/ARCHITECTURE.md](docs/handoff/ARCHITECTURE.md).
Known limitations: [docs/handoff/KNOWN_LIMITATIONS.md](docs/handoff/KNOWN_LIMITATIONS.md).

---

## 1. What Ratchet must guarantee

| # | Requirement | Why it matters |
|---|---|---|
| R1 | **At-most-once initiation.** The same real-world action is authorised at most once. | The product. A duplicate authorisation is a double charge. |
| R2 | **An unknown outcome stays unknown.** | Guessing "succeeded" hides a failure; guessing "failed" causes a double charge. |
| R3 | **Tenant isolation.** No workspace can read or affect another. | Multi-tenant by design; a leak here is a breach. |
| R4 | **Confidentiality of destinations.** Ratchet counts what it cannot read. | Per-counterparty ceilings without holding customer PII. |
| R5 | **Credential integrity.** A database leak alone yields no usable key. | Keys authorise real-world spend. |
| R6 | **Decisions are auditable and non-repudiable.** | A customer must not have to take our word for it. |
| R7 | **An agent cannot widen its own limits.** | A limit an agent can raise is not a limit. |

## 2. Threat model

**Assumed capable adversaries:**

- **A compromised or misbehaving agent** holding a valid API key — prompt-injected,
  looping, or actively hostile. *This is the primary adversary and the product's
  whole reason to exist.* It may send arbitrary payloads, arbitrary declared
  amounts, arbitrary dimension values, and may call any endpoint its scopes allow.
- **A malicious tenant** attempting to read or affect another workspace.
- **A network attacker** between agent and gate.
- **An attacker with a copy of the database** but not the application secret.
- **A supply-chain attacker** targeting dependencies or the release pipeline.

**Explicitly out of scope, and why:**

- **A compromised host or root on the production machine.** Nothing in this
  design defends against that; the secret is readable there.
- **A malicious maintainer.** With one maintainer there is no separation of duty.
  Stated in [GOVERNANCE.md](GOVERNANCE.md) rather than pretended away.
- **A vendor performing the effect twice on its own.** Ratchet authorises; it
  never performs. If Stripe double-charges from one call, that is outside the gate.
- **Sophisticated timing/traffic analysis of blinded dimensions.** Counting is
  observable by design; only the *values* are protected.

## 3. Trust boundaries

```
   UNTRUSTED                        │ TRUSTED                      │ NOT OURS
   ─────────────────────────────────┼──────────────────────────────┼──────────────
   Agent process                    │ Control plane (stateless)    │ Vendor APIs
     payload, declared cost,        │   route JSON-Schema validation│   Stripe, SMTP…
     dimensions, agent_id, run_id   │   auth: scope + workspace     │
     ── all attacker-controlled ──▶ │   domain logic                │ Ratchet holds
                                    │   Postgres (single source)    │ NO credential
   Browser console session          │ Worker (long-running)         │ here and has no
     operator, cookie-authenticated │                               │ outbound access
                                    │                               │ to customer systems
```

**The boundary that defines the product:** Ratchet is on the left of "NOT OURS"
and never crosses it. It has no vendor credentials and no outbound access to
customer systems. A compromise of Ratchet cannot spend a customer's money,
because Ratchet cannot spend it under any circumstance.

**The boundary that carries the most risk:** everything an agent sends is
attacker-controlled and crosses into the domain. The rule is that agent-supplied
text never influences a decision — decisions come from stored policy and database
state only.

## 4. The argument

### R1 — At-most-once initiation

**Claim.** Two concurrent callers with the same
`(workspace, effect_type, idempotency_key)` cannot both be told to execute.

**Argument.** Enforced by a **database unique index**, not by application logic.
Application-level checks lose to concurrency; a unique index does not. A second
insert fails at the storage layer and the caller is told `duplicate` or
`in_flight`. Lock order is fixed (`workspaces → effects → spend_windows`) because
two deadlocks were found here, and `spend_windows` rows are materialised before
they are locked because `SELECT … FOR UPDATE` locks nothing when the row is absent.

**Evidence.** `test/integration/concurrency.test.ts` runs genuinely concurrent
begins. The lock ordering and materialise-before-lock rules are documented in
CLAUDE.md §7 and each was added in response to a real defect.

**We do not claim exactly-once.** It is not achievable. Nothing in the copy,
the docs, or the API says otherwise, and a test asserts the repository never
claims it.

### R2 — Unknown stays unknown

**Claim.** A lease that expires unreported becomes `indeterminate` and is never
auto-resolved.

**Argument.** The reaper only ever transitions `pending → indeterminate`. Moving
out of `indeterminate` requires either an explicit operator resolution with
recorded evidence, or a policy the operator set in advance (`retry`, `probe`),
with `block` as the default. The default is the safe one.

**Evidence.** `test/integration/effects.test.ts`, `test/integration/reaper-drain.test.ts`.

### R3 — Tenant isolation

**Claim.** No query returns another workspace's rows.

**Argument.** Every read is workspace-scoped; there is no unscoped read path. A
cross-tenant lookup returns 404, never a hint the record exists elsewhere.

**Evidence.** Isolation tests in every domain suite. **This defence has failed
once in development and was caught by those tests**: a `FULL OUTER JOIN` with the
workspace predicate in the `ON` clause emitted every tenant's rows, because an
`ON` predicate decides what *matches* and does not filter unmatched rows. Fixed
by narrowing both sides in CTEs before the join. Recorded because an assurance
case listing only successes is marketing.

### R4 — Confidentiality of destinations

**Claim.** Ratchet can count a destination without being able to read it.

**Argument.** A declared dimension is stored as
`HMAC(DIMENSION_SECRET, "dim:v1:<workspace>:<name>:<value>")` truncated to 128
bits. The workspace id is inside the MAC, so the same account number in two
workspaces produces two unrelated identifiers and there is no cross-tenant
correlation to leak. Only the fingerprint of a payload is stored, never the payload.

**Limitation, stated:** the input space for something like a bank account number
is small enough that an attacker **who already holds the pepper** could brute
force it. That attacker already has the application secret and has larger
problems; the pepper is what the defence rests on, not the truncation.

**Evidence.** `test/unit/dimensions.test.ts`, `test/integration/dimensions.test.ts`,
plus assertions in the structuring and fan analyses that a raw account number
cannot appear in a report.

### R5 — Credential integrity

**Claim.** A database copy alone yields no usable API key.

**Argument.** Keys are stored as HMAC-SHA256 peppered with a server-side secret —
never plaintext, never a bare hash. Comparison is constant time and runs even for
an unknown prefix, so timing does not reveal whether a prefix exists. Since
migration 038 the pepper is versioned, so it can be **rotated** without
invalidating every customer key — the one action required after a suspected
compromise, which was previously impossible.

**Evidence.** `test/integration/secret-rotation.test.ts` spawns real processes
under different secrets, because re-importing modules in one process binds to a
cached config and tests nothing.

### R6 — Auditability

**Claim.** A customer can verify our decisions without trusting us.

**Argument.** Every decision is signed and hash-chained. Each receipt carries the
`kid` of its signing key *inside the signed body*, so it cannot be repointed at a
different key, and every public key stays published forever. Rotation therefore
changes only what new receipts are signed with.

**Evidence.** `test/integration/receipts.test.ts`; the chain is verifiable at
`/v1/receipts/audit` and public keys at `/.well-known/ratchet-receipt-key`.

### R7 — An agent cannot widen its own limits

**Claim.** A key with agent scopes cannot raise a ceiling.

**Argument.** `DEFAULT_AGENT_SCOPES` is `effects:begin, effects:report,
effects:read`. Raising a budget needs `policies:write`, which agents do not carry
and for which **no MCP tool exists** — putting one in the toolbox would invite
the call that must not be made. An agent may *read* its remaining balance, which
is what lets it take a cheaper path or stop cleanly.

**The one deliberate exception, and why it is safe.** Declared `dimensions` are
agent-supplied text that selects a ceiling, which CLAUDE.md §6 otherwise forbids.
It is admissible because a declaration can **tighten and never loosen**: it adds
whatever limit policy keys on that dimension, never removes the workspace, key or
type limits, and omitting a required one is refused rather than allowed. A caller
that lies lands in a different bucket and gains nothing it did not already have.
The same one-way property is what makes value-triggered approval safe.

**Evidence.** `test/e2e/run-console.test.ts` asserts an agent key gets 403 on the
budget endpoint; `test/integration/value-approval.test.ts` asserts a small
declared amount cannot downgrade an approval or a denial.

## 5. Common implementation weaknesses

| Weakness | Countermeasure | Evidence |
|---|---|---|
| Injection | Parameterised queries throughout; no string-built SQL | CodeQL, review |
| SSRF | Static validation, DNS re-resolution and **socket pinning** on every attempt; no redirects; private, loopback, link-local, CGNAT and metadata ranges refused | `test/unit/ssrf.test.ts`, `ssrf-delivery.test.ts` |
| Broken auth | Scoped keys, constant-time compare, key-only vs session-only route separation | `test/e2e/api.test.ts` |
| Mass assignment | `additionalProperties: false` on every body, `removeAdditional: false` so a typo is rejected rather than dropped | route schemas |
| Replay | Payment webhooks verified cryptographically over the raw body with a replay window | `test/unit/stripe-signature.test.ts` |
| Secrets in logs | Logger redacts `authorization`, `x-api-key`, `cookie`, `stripe-signature`, `set-cookie` | `test/unit/log-redaction.test.ts` |
| Internal detail leakage | 5xx carries a request id only | error boundary tests |
| Vulnerable dependencies | Dependabot; `npm audit --omit=dev` in CI, currently zero | CI |
| Unsafe deserialisation | JSON only, schema-validated at the edge | route schemas |

## 6. What this case does not cover

- **One maintainer.** No separation of duty, no second reviewer. See
  [GOVERNANCE.md](GOVERNANCE.md).
- **No third-party security audit.** Stated on the public security page too.
- **Single region.** Three database nodes with automatic failover, one region.
- **UTC-day windows, not rolling.** A ceiling can be approached twice across a
  midnight boundary.
- **Ceilings are only as good as what callers declare.** Under-declaring is
  possible; `POST /v1/reconcile` against the vendor's own record is what catches it.

Each is tracked in [KNOWN_LIMITATIONS.md](docs/handoff/KNOWN_LIMITATIONS.md) and,
where it is being addressed, in [ROADMAP.md](ROADMAP.md).
