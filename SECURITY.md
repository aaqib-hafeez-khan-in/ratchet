# Security policy

Ratchet is an effect gate: agents ask it for permission before doing something
they cannot take back. A flaw here does not corrupt data — it lets a real-world
action happen twice, or lets an agent exceed a limit it was given. Please treat
findings accordingly.

## Reporting

**security@ratchetgate.com** — or use GitHub's private vulnerability reporting on
this repository, which reaches the same person.

Please include what you did, what happened, and what you expected. A proof of
concept helps and is welcome; you do not need one to report.

Operated by one person, so: acknowledgement within **72 hours**, an assessment
within **7 days**, and a fix or a documented reason there will not be one before
disclosure. If you have not heard back in 72 hours, assume the mail went astray
and try again — that is a failure on our side, not impatience on yours.

We will credit you by name unless you prefer otherwise.

## Scope

In scope:

- Anything that lets one workspace observe or affect another.
- Anything that lets an effect be initiated twice under the same
  `(workspace, effect_type, idempotency_key)`.
- Anything that lets a caller exceed a policy, budget or circuit breaker it did
  not itself configure — including an agent key raising its own limits.
- Forging or replaying a signed receipt, or breaking the receipt hash chain.
- Server-side request forgery through webhook delivery.
- Authentication, session, or API-key handling.

Out of scope:

- Findings that require a compromised operator credential to begin with.
- Missing hardening headers with no demonstrated impact.
- Volumetric denial of service. Rate limits are documented as approximate.
- Reports from automated scanners with no analysis attached.

## What is deliberately true

These are design decisions, not bugs. Reporting them is welcome as discussion,
but they will not be treated as vulnerabilities:

- **Exactly-once is not provided and is not claimed.** Ratchet guarantees
  at-most-once *initiation*. A lease that expires unreported leaves the effect
  `indeterminate` and it stays that way until a human resolves it.
- **Ratchet never performs the side effect** and holds no vendor credentials.
- **Raw payloads are never stored**, only a SHA-256 fingerprint.
- **The worker must be long-running.** Deploying it as a serverless function
  means leases never expire. That is a deployment error, documented in
  `docs/handoff/KNOWN_LIMITATIONS.md`.

## Supported versions

The deployed service at ratchetgate.com is the supported version. This repository
tracks it. `ratchet-mcp` on npm is supported at its latest published version.
