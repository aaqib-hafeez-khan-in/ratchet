# The same job, with and without the gate

**2 Sep 2026** · `npm run bench:ab` · against production

Everything about this product is a counterfactual — the charge that did not happen. You cannot
see it, so the honest way to make the claim is to run the same job both ways and count what a
third party received.

## The setup

A local server stands in for a payments API. It records every refund it **actually performs**,
and that record is the ground truth — not what the agent believes, not what Ratchet reports.

The failure simulated is the one that matters and the one people under-model: **the request
arrives, the vendor executes it, and the response is lost on the way back.** The caller sees a
timeout and cannot tell it apart from a request that never landed. Retrying is correct behaviour
and is also what charges the customer twice.

- 40 refunds of $240.00
- 25% of responses lost in flight
- Up to 3 retries, which is what a well-built agent does
- **The same seeded failure sequence in both runs**, so request #3 fails identically in each.
  Without that, the comparison measures luck.

## Result

| | Without the gate | With the gate |
|---|---|---|
| Refunds the vendor performed | **53** | **40** |
| Distinct customers refunded | 40 | 40 |
| **Duplicate refunds** | **13** | **0** |
| Money moved | $12,720.00 | $9,600.00 |
| Money that should have moved | $9,600.00 | $9,600.00 |
| **Overpaid** | **$3,120.00** | **$0.00** |

**13 duplicate refunds prevented. $3,120 not lost, on a job worth $9,600 — 32.5% of the run's
value paid out twice.**

Identical across two consecutive runs, because the failure sequence is seeded. The correctness
result is not a sample; it is deterministic.

## What it costs

Measured the same day, and worth stating carefully because the first reading was wrong:

| | From a laptop | From inside the datacentre |
|---|---|---|
| `GET /healthz` | p50 37ms | p50 **3ms** |
| `begin` (new effect) | p50 184ms · p95 1679ms | p50 **26ms** · p95 98ms |
| `begin` (replay) | p50 305ms · p95 1164ms | p50 **13ms** · p95 32ms |

Two corrections the second measurement forced:

- From the laptop, **replay looked slower than a new effect**, which is backwards. Served
  locally it is half the cost, as it should be. The first reading was noise.
- The **p95 above one second is TLS and the public internet**, not the gate. The same machine
  answers `/healthz` in 3ms.

**The honest statement of cost is ~25ms of server time, plus your round trip to us.** An agent
running in the same region pays the first number. One on a laptop pays mostly the second.

The site's published 2.3ms/5.1ms figures are in-process, measured with `scripts/bench.ts` and
labelled as excluding network. They remain accurate; they are just not what a caller experiences.

## What this does not show

- **A 25% loss rate is severe.** It was chosen to produce a legible result in 40 jobs, not
  because it is typical. At 1% the duplicate count falls roughly proportionally; the mechanism
  is identical.
- **The vendor here has no idempotency of its own.** Against a vendor that supports idempotency
  keys and is called correctly, some of these duplicates would have been caught downstream. The
  gate's argument is for the vendors that do not, and for actions spanning more than one of them.
- **Nothing here measures agent quality.** The gate makes the action happen once. It has no view
  on whether refunding that customer was a good idea.

Reproduce with `npm run bench:ab`. It provisions its own workspace and needs no credentials.
