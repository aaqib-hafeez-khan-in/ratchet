# Site copy audit — 31 August 2026

Triggered by a visitor's complaint. Worth keeping because the complaint was a
symptom of a class of bug, not a one-off wording problem.

## The complaint

> So you say there's no signup but then you say get a key. The viewer is
> supposed to understand the one workflow where the agent identifies the service
> and the second workflow where the person identifies the service and signs up.

They were right, and the fault was ours. Both statements were true and the site
never said how they related, so a reader had to build the model themselves from
two sections that were a full screen apart.

## What was actually wrong

The homepage had a section headed **"No signup"**. That reads as a claim about
the product. Two hundred pixels above it sat a button reading **"Get an API
key"**. Nothing on the page said these describe *different callers*.

They are two doors into the same workspace:

| | How it starts | Allowance |
|---|---|---|
| A person | Creates a workspace with an email in the console | Free plan — 1,000 gated effects a month |
| An agent | Calls `begin` with no credential; a workspace and key come back with the decision | Capped at 100 gated effects |

**Claiming is the join.** An agent-provisioned workspace becomes a free-plan
workspace when someone claims it with an email. Same workspace, same key, no
migration. That was implemented and documented but never stated where the
confusion happened.

## Fixes

1. A two-column panel in the hero, directly under the buttons: *If you are a
   person* / *If you are an agent*, and a joining sentence about claiming. The
   contradiction is now resolved in the place it was created.
2. The section heading "No signup" is now **"The agent's door"** — a fact about
   one path rather than a claim about the product.
3. The duplicated allowance line above the panel was removed; "no card" moved
   into the panel where it still earns its place.

## The larger finding

Auditing for the above surfaced two claims that were true when written and had
silently become false:

- **`web/console.html`** — the signup form said *"No mail is sent by this
  build."* Transactional email had been deployed for some time. That line told
  people the alerts they most need (indeterminate outcome, waiting approval,
  opened breaker) were not coming. This is worse than a typo: it actively
  discourages relying on a shipped safety feature.
- **`web/security.html`** — said *"this build ships no contact address"* while
  `security.txt` published `security@ratchetgate.com` and Cloudflare Email
  Routing delivers it. A researcher reading the page would conclude there was
  nowhere to report a vulnerability.

Both are now correct, and the second has a test
(`test/e2e/canonical.test.ts` → *"the security page offers the contact
security.txt promises"*). It compares the **mailbox**, not the whole address:
`security.txt` takes its host from config, so it is `security@localhost` under
test, while the page is a static asset naming the real domain.

**Rule going forward:** when a capability ships, grep the site for copy that
denied it. `CLAUDE.md` §11.6 already requires this; it was not being done.

## Also in this pass

Blog → Notes, URLs included. `/blog` and `/blog/<slug>` answer **301**, not 404 —
the article is indexed and the URL appears in `PROMOTION_COPY.md`. A typo under
either prefix still 404s. Covered by four tests in `test/e2e/canonical.test.ts`,
including one asserting no page still links to `/blog`.

An RSS `pubDate` named the wrong weekday (Sun for 31 August 2026, a Monday).

---

# Addendum — 1 September 2026

## The user's question

> Are reversible effect groups and surge containment important? A before and
> after case study might show benefits.

**Yes, and the case study was the right instinct with the wrong format.**

A case study needs a customer. We have none, and writing *"Acme cut duplicate
charges by 94%"* would be fabricating evidence for a product whose entire claim
is that it tells the truth about what happened. That trade is never worth it.

What replaces it: **`scripts/case-study.ts`** — a script that runs both
scenarios against a live instance and prints the real transcript. Published as
[/notes/what-happens-when-step-five-fails]. Anyone can run `npm run case-study`
and get the same shapes and the same counts. Reproducible beats persuasive.

## Two things the script found

**The API refused to hand back a rollback plan.** An early version reported the
failed payment with an `error` field instead of `failure_reason`. Bodies are
`additionalProperties: false`, so the API correctly returned 400 — and the
script did not check, so the payment was still `pending` at unwind time. The
reply was not the plan; it was `"STOP. 1 effect(s) in this group have an unknown
outcome."` That behaviour was not written for this test and is the single most
dangerous moment in any compensation flow. It is now quoted in the article.

**A true number with the wrong cause.** The first surge run fired 600 attempts
and reported the ceiling held them to 19. True — but 495 were refused by the
*request rate limiter*, several layers earlier. Surge containment only judged
about 100 of them. Publishing that would have credited the wrong mechanism, and
nobody outside could have caught it. The burst is now kept under the request
limit so the measurement isolates the ceiling: **100 concurrent distinct charges,
20 execute, 80 denied**, in 341ms.

Both failures came from the same habit: not checking a response. `call()` in
the script now throws on any unexpected status. Compare the backup script that
swallowed errors into `/dev/null` — same bug, third occurrence.

## Rule

Never publish a measured number without checking which mechanism produced it.
A number whose cause is misattributed is worse than one that is simply wrong,
because it survives review.
