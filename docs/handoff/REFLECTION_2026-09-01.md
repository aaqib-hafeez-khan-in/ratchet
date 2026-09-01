# Reflection — 1 September 2026

The operator asked me to stop and reflect. Doing it properly, because there is
something here I had not seen.

## Five complaints, one complaint

Every piece of user feedback we have received:

1. *"You say there's no signup but then you say get a key."*
2. *"These three CTAs go to the same form — does something different happen?"*
3. *"When you click Notes it brings up the URL blog."*
4. *"I don't see Figma. Does Ratchet work with MCP? If so why aren't there any listed?"*
5. *"Add something for simple-minded people like me — 100 gated effects, claiming
   upgrades to 1,000."*

I had been treating these as five unrelated bugs. They are one bug, five times.

**Every capability was built, exposed to machines, and left invisible to people.**

- The vendor directory has 12 vendors with verification dates. Figma is in it.
  It is reachable only as raw JSON at `/v1/vendors`, linked once, from a
  sentence deep on the homepage, labelled "free vendor directory". A person who
  clicks it gets a wall of JSON. **The user was right that Figma is missing —
  missing from the site, present in the product.**
- 24 MCP clients are listed on Works with. A user still asked whether we support
  MCP, because the page never says the word prominently and never explains that
  those 24 names *are* the MCP answer.
- Ratchet already learns. `surge_multiplier` sets a ceiling as a multiple of a
  seven-day median the worker computes, with a floor so a quiet effect type is
  not tripped by one busy hour. It appears in one table row in the docs. The
  operator asked *"perhaps Ratchet can learn?"* — it does, and we never said so.
- The two entry paths both worked. Nothing said how they related.

## Why this is worse for us than for most products

Ratchet's entire pitch is: *an unknown outcome stays unknown, and we tell you
rather than let you assume.* We hold the API to that standard rigorously — there
is a whole state, `indeterminate`, that exists only to avoid making the reader
infer something we do not know.

Then the website asks its readers to infer constantly. We apply our own
principle to machines and not to people. That is the actual defect, and it will
keep generating "bugs" until it is fixed at the root.

## The rule this produces

**If a capability exists, some page must state it in a sentence a person can
read.** A JSON endpoint is not documentation. A table row is not an
explanation. Shipping the feature is half the work.

Concretely, from now on: a feature is not done when the API and the docs table
are updated. It is done when a person who does not already understand the
product can find out that it exists.

## What I am still missing

Things I can see but have not yet resolved, recorded so they are not lost:

- **No feedback path on the site.** Every complaint so far reached us through the
  operator personally. There is no "this page confused me" anywhere. We are
  learning from a sample of one person's inbox.
- **No search.** The docs are long and there is no way to ask them a question.
- **The console is the only place policy is explained in plain language**, and
  you need an account to see it.
- **We measure nothing about comprehension.** We do not know which page people
  leave from, and I would rather not add tracking to find out — but that means
  the operator relaying screenshots *is* our analytics, which is why every one
  of these took so long to surface.
