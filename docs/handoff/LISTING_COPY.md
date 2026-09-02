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
