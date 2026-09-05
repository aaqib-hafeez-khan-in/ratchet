# Code review

What review means on this project, what a reviewer checks, and what makes a
change acceptable.

## Who reviews

Two people can review Ratchet, and since 5 September 2026 the repository
**requires** that one of them does.

`main` carries a ruleset with **no bypass actors**: a change reaches it only
through a pull request carrying at least one approving review, and
`require_last_push_approval` means whoever pushed last cannot be the one who
approves. That binds the maintainer too, which was confirmed by pushing directly
and being refused rather than assumed from the settings page:

```
remote: - Changes must be made through a pull request.
 ! [remote rejected] main -> main (push declined due to repository rule violations)
```

Before that, 244 of Ratchet's 247 commits reached `main` without a pull request.
That history does not disappear, and it is why the OpenSSF gold criterion
`two_person_review` — at least 50% of proposed modifications reviewed before
release by somebody other than the author — is answered on the rule rather than
on the archive. From here the proportion is 100%, held there by machinery rather
than by intention. A reviewer who leaves no trace is indistinguishable, from
outside, from no reviewer at all; the trace is now mandatory.

What follows is what that reviewer checks — several of the checks automated,
because a second pair of eyes catches different things than a test does and
neither substitutes for the other.

## What every change must pass

**Automated, and not optional.** CI runs on every push to `main` and every pull
request. A change is not acceptable until all of it is green:

- `npm test` — typecheck of `src`, `test` and `scripts`, then unit, integration
  and end-to-end suites against a disposable PostgreSQL database.
- `npm run fuzz` — property-based tests over the payload fingerprint, the SSRF
  guard, and payment signature verification.
- `npm run audit` — zero production dependency vulnerabilities. A registry
  outage is reported as an outage, never as a pass.
- CodeQL on every push, plus a weekly scheduled run.

**By reading, against [CLAUDE.md](../CLAUDE.md).** That file is the project
contract, and a reviewer checks the change against it rather than against
taste. In particular:

- Does it preserve at-most-once initiation in the database, not in application
  logic?
- Does it keep an unknown outcome unknown, rather than resolving it to a guess?
- Does it store a raw payload anywhere, or only a fingerprint?
- Is every query workspace-scoped?
- Does agent-supplied text reach a decision? The one permitted exception is a
  declared dimension, and only because a declaration can tighten and never
  loosen.
- Does the lock order `workspaces → effects → spend_windows` still hold?

**Tests, at the right layer.** New behaviour needs a test, and the categories in
CLAUDE.md §8 make one mandatory: state transitions, authorization, tenant
isolation, idempotency and replay, rate limits, billing idempotency, SSRF,
webhook signing, lease fencing.

**A test that has been watched to fail.** This is the check that catches the
tests which cannot fail. Before a test is trusted, break the implementation it
covers on purpose and confirm the test goes red. This project has shipped a
log-redaction test that passed against an unredacted logger, and a fuzz harness
whose mutations silently patched nothing — both were found this way and neither
would have been found by reading.

**Claims must be true.** If the change makes a statement in the README, on the
website, in the MCP tool descriptions, or in the OpenSSF badge answers untrue,
it is not finished. Several tests exist only to enforce this: the published
surface may not name an endpoint or tool that does not exist.

**Numbers must be measured.** Never quote a coverage percentage or a benchmark
figure from memory. Run `npm run coverage` or `scripts/bench.ts` and quote what
it prints.

## What makes a change unacceptable

- It weakens a boundary in CLAUDE.md §5 without saying so explicitly.
- It claims exactly-once, in code or in copy.
- It adds a way for an agent to raise its own ceiling or close its own circuit
  breaker.
- It makes a test pass by changing the test rather than the code.
- It leaves `main` unable to build, migrate, or deploy.

## After review

Merging is not shipping. `npm run deploy` refuses to promote a build that is not
committed and pushed, whose CI is not green, that staging is not already
running, or whose staging smoke test does not pass right now. The escape hatch
for an incident is a separate command, `npm run deploy:force`, so it cannot be
reached by habit.
