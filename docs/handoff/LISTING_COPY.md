# Listing copy

The same product described at four different lengths, because four places impose four
different limits. Kept together so a change to one is an obvious prompt to check the others,
and so nobody retypes a description from memory into a form.

---

## Glama server profile — no published limit

Pasted by hand at <https://glama.ai/mcp/servers/thearchitect0x-glitch/ratchet> · **296 chars**

> Your agent asks before it does anything it cannot take back — charge, deploy, publish, send — and gets a durable decision, so the same real-world action is attempted at most once across crashes and retries. Also gives agents a memory of what a run already did and a spend limit they cannot raise.

**Why this one and not the previous.** The old description — *"Enables AI agents to gate
real-world side effects through a durable decision record, ensuring at-most-once initiation,
deduplication, budget enforcement, and auditable outcomes"* — was passive, led with mechanism,
and named no concrete action. A reader had to already understand the category to get anything
from it. This one opens on the moment the product exists for and names four actions, so the
problem lands before the vocabulary does.

---

## README opening paragraph — the one Glama actually displays

`README.md`, first paragraph after the title · **369 chars**

This turned out to be the highest-leverage description of the five. The Glama server page
renders the README's opening paragraph as the listing body; the profile-form description above
appears to drive search results and cards rather than the page itself. So the README opening is
listing copy whether or not it was written as such.

> **An effect gate for AI agents.** Your agent asks before it does anything it cannot take back — charge a card, ship a deploy, publish a package, send the email — and gets a durable decision, so the same real-world action is attempted at most once across crashes and retries. Agents can also read back what a run already did, and spend against a limit they cannot raise.

Rewritten 2 Sep 2026 into the same voice as the profile description. The previous version —
*"Ask before you act; Ratchet answers durably, so the same real-world side effect is attempted at
most once, stays inside a declared budget, and leaves an auditable record"* — was accurate and
entirely abstract: it named no action a reader could picture. The category still leads in three
bold words, because somebody landing on a repository wants to know what kind of thing it is
before they want a pitch.

**If you edit the README's first paragraph, you are editing the Glama listing.** That is not
obvious from either end.

---

## MCP registry `server.json` — **hard limit 100 characters**

The schema at `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
sets `maxLength: 100`. A longer value is rejected at submission, so the long version above
cannot be used here.

> Your agent asks before it acts, so the same real-world action is attempted at most once.

*(88/100)*

---

## npm — `packages/ratchet-mcp/package.json`

No hard cap, but npm search truncates around 130 characters.

> MCP server for Ratchet. Your agent asks before it charges, deploys, publishes or sends — the same action is attempted at most once.

*(131 chars)*

---

## Repository `package.json`

Describes the service rather than the MCP bridge, so it stays distinct on purpose.

> Ratchet — the effect gate for AI agents. At-most-once side effects, budget enforcement, and an auditable execution record.
