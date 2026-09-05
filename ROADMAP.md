# Roadmap

What Ratchet intends to do, and not do, over the next year. Written 3 September
2026 and reviewed when it stops being true rather than on a schedule.

Ratchet is an effect gate: an agent asks permission before doing something it
cannot take back, and gets a durable decision. Everything below is judged against
whether it makes that more trustworthy.

## Now — shipped and running

- The gate itself: at-most-once initiation, leases with fencing tokens,
  indeterminate outcomes that stay indeterminate.
- Per-effect-type policy, spend ceilings, and per-destination ceilings over
  blinded dimensions.
- Surge containment, run budgets, value-triggered approval.
- Signed receipts with a hash chain, and per-record key resolution so signing
  keys can rotate without invalidating history.
- Structuring and fan-in/fan-out analysis over blinded dimensions.
- Reconciliation, with a cadence the gate tracks and reports on.
- `AUTH_SECRET` rotation without invalidating customer keys.

## Next — the next six months

**Continuity, done.** A partner at Deimos AI LLC holds the credentials the
project depends on and, since 5 September 2026, admin on the repository. The
project now survives the loss of any one person, which was the largest single
risk to anyone depending on Ratchet. One item remains from it, and it outranks
every feature below:

- **A review record.** Two people can approve a pull request; nothing requires
  one. 244 of 247 commits reached `main` without one, so the history cannot show
  which changes a second person saw before release — and a reviewer who leaves
  no trace is indistinguishable from no reviewer. Routing changes through pull
  requests is what makes it visible; see
  [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md).

- **Scheduled reconciliation reaching further.** The gate keeps the calendar
  today; the natural next step is a vendor-side adapter *the customer* runs and
  points at us, so the comparison is automatic without Ratchet ever holding a
  vendor credential.
- **Rolling windows.** Daily ceilings reset at UTC midnight, so a ceiling can be
  approached twice across a boundary. Documented in
  [KNOWN_LIMITATIONS.md](docs/handoff/KNOWN_LIMITATIONS.md); a rolling window is
  the fix.
- **Coverage toward gold.** Measured 5 Sep 2026 by `npm run coverage` over all
  three suites: statements 91.1%, branches 81.88%, functions 92.13%. The 85%
  this line used to claim predated the two corrections to what the figure
  counts. The useful target is the uncovered branches in the worker and billing
  paths, not the number.
- **A second region.** The database is three nodes in one region with automatic
  failover. Single-region is a real limitation for anyone with a recovery
  objective that spans a regional outage.

## Later — under consideration, not committed

- An SDK beyond the MCP bridge, if enough callers ask in a language where the
  HTTP API is awkward.
- Per-workspace retention beyond the current plan ceilings.
- A hosted approval queue UI, if operators ask for one rather than using webhooks.

## Explicitly not doing

These are decisions, not omissions. Each has been considered and declined.

- **Exactly-once delivery.** It is not achievable, and the whole product is
  built on saying so. No amount of demand changes this.
- **Performing side effects on a customer's behalf.** Ratchet holds no vendor
  credentials and has no outbound access to customer systems. That boundary is
  the product's main safety property. Every request to "just call Stripe for me"
  is declined.
- **Storing raw payloads.** Only a fingerprint, and only a keyed MAC for
  declared dimensions. Not negotiable — it is what makes per-destination
  ceilings safe to offer.
- **Auto-resolving an unknown outcome.** A lease that expires unreported stays
  `indeterminate` until somebody verifies. Guessing is the one thing a gate must
  never do.
- **Becoming an agent framework.** Ratchet is one narrow control that composes
  with whatever you already use.

## How this changes

By pull request, or by the maintainer when reality moves. If something here has
been "Next" for a year, it belongs in "Later" or in "Not doing", and moving it
is more honest than leaving it.
