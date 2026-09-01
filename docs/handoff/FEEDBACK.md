# Page feedback

## Why it exists

Every usability problem we have fixed arrived as a screenshot forwarded by the
operator, days after someone hit it. That is a sample of one person's inbox, and
it is the reason each of the five complaints in `REFLECTION_2026-09-01.md` took
days rather than minutes to surface. This is the missing channel.

## Shape

A quiet line at the end of every page: **Was this page clear?** with Yes and No.
Yes is one click. No opens a small form — an optional message, an optional
email. Injected by `mountChrome`, so no page can be forgotten. Skipped on
`/console`, which is an application rather than something to be understood.

- **Write:** `POST /v1/feedback`, unauthenticated.
- **Read:** `npm run feedback`. There is no HTTP read (see below).
- **Storage:** `page_feedback`, migration 025.

## Three deliberate decisions

**No credential on the write.** A reader who cannot follow the pricing page has
no workspace and no key. Requiring one would exclude exactly the people whose
confusion matters most. This is the second unauthenticated write in the service,
so it is the least powerful thing it could be: it creates nothing, grants
nothing, reads nothing, and returns no information about anything that exists.

**No HTTP read at all.** Site feedback belongs to no workspace, so every
credential the API has is the wrong shape. A console session would let *any*
workspace owner read everything every visitor wrote. Rather than invent an admin
credential and a production-safety check to guard it, the operator reads this
against the database they already have. A public write plus a public read is a
graffiti wall; this is a write-only letterbox.

**No identity.** No cookie, no stored IP, no fingerprint. Two submissions from
one person are not linkable by us, on purpose — the question is *which page
confuses people*, not *who is confused*. The optional email exists only to reply
to that one message. `localStorage` stops the widget re-asking, and lives only
in that reader's browser.

## Abuse controls, in order

1. **Route limit** — 10/minute per IP, via `stricterThan()`.
2. **Global ceiling** — 60/minute across all sources, enforced in the database,
   because the per-IP limit is evadable and this is not.
3. **Path allowlist** — only paths this site could serve. Without it a stranger
   chooses what appears in our own report.
4. **Honeypot** — a `website` field no human sees. Anything in it is dropped.
5. **Control characters stripped**, newlines and tabs kept.
6. **Always 202.** A rejected submission is answered exactly like an accepted
   one, so the filter is not discoverable — and a reader who typed a paragraph is
   never shown an error about our infrastructure.

## Two bugs this found

**The global ceiling did not hold.** The first version read the count, compared
it, then incremented — three statements, no lock across them. 85 concurrent
callers all read a number below the ceiling and all 85 were stored. Same
lost-update bug as the spend window, and the comment in the code claimed to
implement the fix that was not there. Now one `INSERT ... ON CONFLICT DO UPDATE
... WHERE count < $2 RETURNING count`, which decides under the row lock.

**A hardcoded rate limit made the route untestable.** `{ max: 10 }` ignores
`RATE_LIMIT_OVERRIDE`, and since `RATE_LIMIT_SHARED` defaults to true the bucket
is Postgres-backed and survives the process. Three e2e tests returned 429 before
sending a single request, because earlier runs of the same file had filled it.
`stricterThan()` in `src/api/rate-limit.ts` is the fix; `limits.test.ts` proves
the strictness is still real with the override cleared.

> Use `stricterThan(n)` for any route stricter than the plan. A bare
> `{ max: n }` is the same bug waiting to happen. `workspace.ts` still has two.

## Still missing

Nothing notifies anyone. The operator must run `npm run feedback`, which has the
same failure mode as today — just faster. A worker digest gated on an optional
`FEEDBACK_DIGEST_TO` would close the loop and is the obvious next step.
