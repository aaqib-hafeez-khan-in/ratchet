# Contributing to Ratchet

Ratchet is an effect gate: an agent asks permission before doing something it
cannot take back, and gets a durable answer. That makes correctness a safety
property rather than a preference, so the bar here is a little unusual and worth
knowing before you start.

**Read [CLAUDE.md](CLAUDE.md) first.** It is the project contract — the invariants,
the domain vocabulary, the concurrency rules, and the things that must stay true.
Every claim in it is enforced by a test or a config check. If you break one, a
test fails: fix the code, not the test.

## Getting set up

```bash
npm install
npm run dev:db          # Postgres on :5433, needs Docker
npm run migrate
npm run dev             # control plane on :8787
npm run dev:worker      # lease reaper + webhook delivery
```

`npm test` runs typecheck, unit, integration and e2e against a disposable
database. It needs Docker. Integration and e2e share one database and run
single-threaded on purpose — the worker's sweeps are global.

## Reporting a bug

Open a GitHub issue with what you did, what happened, and what you expected.
A failing test is the best possible bug report and is always welcome.

**Do not open a public issue for a security problem.** See
[SECURITY.md](SECURITY.md) — mail security@ratchetgate.com or use GitHub's
private vulnerability reporting.

## Proposing a change

Open an issue before a large change, so nobody spends a weekend on something
that will not be merged. Small fixes can go straight to a pull request.

Pull requests should:

1. **Pass `npm test` in full.** Typecheck, unit, integration, e2e.
2. **Come with a test at the right layer.** Unit for pure logic, integration for
   anything touching Postgres, e2e for anything crossing HTTP. A change to state
   transitions, authorization, tenant isolation, idempotency, rate limits,
   billing, SSRF, webhook signing or lease fencing **must** have one.
3. **Update `src/api/schemas.ts`** if the wire contract changed, so the published
   OpenAPI document stays accurate.
4. **Update the relevant `docs/handoff/*.md`.** Those are living memory, not a
   release artifact.
5. **Leave no claim untrue** in the README, the web pages, or the manifest.

## House style

- **Comments explain _why_.** The code already says what.
- TypeScript strict, `noUncheckedIndexedAccess` on, ESM with `.js` extensions in
  relative imports.
- Wire format is `snake_case`; the domain is `camelCase`. Conversion happens in
  `src/api/serialize.ts` and nowhere else.
- Money is integer micro-USD. Never floats.
- Do not claim coverage percentages — no coverage tool is configured. Do not
  claim measured performance without running `scripts/bench.ts` and quoting the
  real output.

## Things that are not up for negotiation

- **Exactly-once is never claimed.** It is not achievable. At-most-once
  initiation is, and it is enforced by a database unique index rather than by
  application logic.
- **An unknown outcome stays unknown.** A lease that expires unreported becomes
  `indeterminate` and is never auto-resolved to a guess.
- **Only a payload fingerprint is stored**, never the payload.
- **Ratchet never performs the side effect.** It holds no vendor credentials and
  has no outbound access to customer systems. That boundary is the product.

## Licence

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same licence as the project.
