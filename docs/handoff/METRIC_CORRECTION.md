# What `useCount` actually measures — and what it cannot support

## The claim I made

That the agent-governance category has near-zero adoption, and that low activation
friction predicts adoption. Feature #1 (keyless first contact) was justified partly
on that reasoning.

## What I verified afterwards

Smithery's own documentation defines the field as **"Total number of times this
server has been connected to."**

Connections. Not installs, not unique users, not customers.

## Why that breaks the argument

**A connection is not a user.** An agent that reconnects on every task generates
one count per connection. A server at 3,060 could be three enthusiastic users, or
one CI loop. A server at 0 could have paying customers who reach it directly
rather than through the listing.

**The sample is Smithery-hosted servers only.** All 37 servers returned carry a
`server.smithery.ai` connection URL. Anything listed elsewhere — including
Ratchet, which is in the official MCP registry and not on Smithery — does not
appear at all. Absence is not zero.

**The distribution is thin.** Median 10 connections, 15 of 37 at zero. At that
scale the differences between individual servers are noise, not signal.

## What the data can and cannot say

It **can** say: among Smithery-hosted servers matching these queries, connection
counts are low and highly skewed.

It **cannot** say: which products have customers, why some are used more than
others, or that friction predicts adoption. My original conclusion and the
correction I made to it are both unsupported by this metric.

## Consequences

- The planned post built on that finding was not published, and should not be.
- Keyless first contact remains a defensible feature on its own merits — removing
  a human from an agent's path is a real improvement — but **not** on the
  evidence originally cited for it.
- Any future market claim needs a metric whose definition was read first.

## The process failure worth remembering

I ran one narrow query, saw a pattern, and built strategy on it without reading
what the number meant. The correction came only because it was challenged. Read
the field definition before the field becomes an argument.
