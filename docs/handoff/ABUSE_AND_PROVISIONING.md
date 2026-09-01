# Can someone play the system for free gates?

Yes, they could. Measured, not theorised.

## What the exposure was

`POST /v1/effects/begin` with no credential provisions a workspace and hands
back a key. The ceiling was `PROVISION_LIMIT = 20` per hour per IP, held in a
**JavaScript Map in the API process**.

Running it against a local instance:

```
{ "workspaces": 20, "blocked": 10, "freeGatesObtained": 2000 }
```

**2,000 free gated effects an hour, from one address, with no credential.** The
free *plan* is 1,000 a month. The anonymous path was sixty times more generous
per hour than the paid-adjacent free tier is per month.

And the real number was worse than 2,000, three ways:

| Flaw | Effect |
|---|---|
| In memory | Per instance. Multiply by the number of API machines. |
| In memory | Resets on deploy. Every deploy handed everyone a fresh ration. |
| Keyed on IP alone | An address is the cheapest thing on the internet to rotate. |

The original comment defended the Map: *"an unclaimed workspace is small,
capped, and swept by the worker."* That is true and it answers the wrong
question. The threat modelled was **table growth**. The actual threat is
**free-gate arbitrage**, and nothing in that sentence bounds it.

## What it is now

Two ceilings in Postgres, each claimed in a single statement so the check and
the increment happen under the same row lock.

**Per source** — `PROVISION_PER_SOURCE_PER_HOUR`, default **5**. Keyed on
`HMAC(AUTH_SECRET, ip)`, never the address: we need to count repeat callers, not
keep a log of who visited. Five is more than a developer trying the service ever
needs.

**Global** — `PROVISION_GLOBAL_PER_HOUR`, default **250**. This is the one that
holds, because rotating addresses does not move it. At the ceiling, keyless
provisioning stops and the caller is told to create a workspace the ordinary
way. **Every request presenting a key is completely unaffected.**

That second ceiling is deliberately the same shape as the surge containment we
sell: stop the cheap unbounded thing, keep serving everyone who is identified.
We now apply our own product to ourselves.

Measured after: `{ "workspaces": 5, "blocked": 25, "freeGatesObtained": 500 }`,
and **0** after a restart in the same hour — where before, a restart reset it.

## Three bugs found while fixing it

**The ceiling would have leaked under concurrency** had it been written the
obvious way. Read, compare, increment is three statements with no lock across
them. `test/integration/provisioning.test.ts` fires eight times the limit in
parallel specifically to catch this. It is the same bug the feedback ceiling had
and the spend window had before that.

**A durable ceiling makes its own feature untestable.** Once the counter
outlives the process, any suite that provisions more than the limit fails for
the rest of the hour — and so does every later run. Suite-wide defaults in
`test/helpers.ts` lift it; `provisioning.test.ts` sets it low on purpose.

**Config read at module load is decided by import order.** `int()` captures the
environment when config is first imported. A test file importing `app.js` on one
line and `helpers.js` on the next froze the default before helpers could raise
it, and the failure looked like a bug in the feature rather than in the wiring.
Both limits are now getters, like `rateLimitOverride`.

> **Rule:** any config value a test needs to vary must be a getter. A value read
> at module load is a value whose meaning depends on import order.

## What is still open

- **Claimed-workspace farming.** Claiming needs only an email, and disposable
  addresses are free. 1,000/month each is a far better rate than 500/hour of
  anonymous quota, so this is now the cheaper attack. Not yet bounded.
- **No alerting on pressure.** `provisionPressure()` exists and nothing watches
  it. We would learn we were at the global ceiling from a user complaint.
- **The global ceiling is a blunt instrument.** At the ceiling, a legitimate new
  agent is refused alongside the attacker. 250/hour is generous enough that this
  should be rare, but the failure mode is real and should be measured before it
  is tuned.

---

## Claimed-workspace farming — closed 1 Sep 2026

**The hole.** Claiming a workspace wrote `owner_email` and lifted the cap from 100 gated
effects to the free plan's 1,000. Nothing checked the address existed. Measured: one source
could open **five workspaces an hour, each a full free plan**, with addresses that never had
to be reachable — and rotating the source removed even that bound. After keyless
provisioning was tightened, this was the cheapest remaining route to free gates, and the
only one with no ceiling at all.

**What was done.** Migration 028 adds `email_verified_at`, `verification_hash` and
`verification_sent_at`. A workspace runs at the unclaimed cap until the address answers.

**The distinction that matters: this gates the ALLOWANCE, never the signup.** A workspace is
still created and a working key returned in one request. Keyless provisioning could be
refused outright because there is a fallback — create one the ordinary way. Refusing a real
signup has no fallback, and turning away customers during a launch spike is a worse failure
than serving an attacker a hundred free effects.

**Grandfathering.** The migration backfills every already-claimed workspace to
`COALESCE(claimed_at, created_at)`. Without it, all 28 claimed production workspaces would
have dropped from 1,000 effects to 100 on deploy — including the one running our own uptime
probe. Verified after deploy: **28 claimed, 0 demoted, 0 anonymous wrongly promoted.**

**Token handling.** Stored as HMAC-SHA256 under `AUTH_SECRET`, compared in constant time,
48-hour TTL. A verification link flips billing state for whoever holds it, so it is treated
as the bearer credential it is.

**Not cleared on redemption.** Clearing it looked tidier and made a second click report *"we
do not recognise that link"*. Mail clients prefetch links and people click twice, so that
message would have gone to people whose accounts were fine. Idempotency comes from
`email_verified_at` instead, leaving the token inert — all it can do is set something already
set.

**Both refusals carry their own instruction.** An anonymous workspace at the cap is told to
claim it; a claimed-but-unconfirmed one is told to click the link it already has. The code
stays `quota_exhausted` for both. Telling somebody who has already given us their address to
go and give us their address reads as a broken product rather than as one remaining click.

**What an attacker now pays.** A reachable inbox per workspace. That was the cost that was
missing.

