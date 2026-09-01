# Alerting

## What exists

`.github/workflows/uptime.yml` probes production every 15 minutes. It does not
ping a port — it drives the real product: health endpoints, then `begin`,
`begin` again (asserting the same key is never authorised twice), then `report`
to close the lease.

On failure it runs `scripts/alert.mjs down`, which emails through Resend — the
same provider that already sends Ratchet's transactional mail, so no new vendor.
On recovery, and only when the previous run failed, it sends an all-clear.

## Honest limitations, stated rather than discovered

**This is a notification, not a page.** If nobody looks at a phone at 03:00, it
does not wake anyone. Wiring a real push channel is a ten-minute change once
someone decides which one; nobody has decided, so it is email.

**Monitoring depends on GitHub Actions.** If Actions is down or delayed,
monitoring is down or delayed with it. That is the trade for zero cost and zero
new vendors, and it means this is a safety net rather than a guarantee.

**Scheduled workflows run from the default branch.** Changes to the probe or the
alert path do nothing until they are on `main`, however thoroughly they are
tested on a branch. This is not obvious and has already caused one incident —
see below.

## Configuration

Two repository secrets. Without them the alert step prints what to set and exits
0, so an unconfigured channel never becomes a second alarm:

```
gh secret set ALERT_EMAIL      --repo <owner>/<repo>   # where alerts go
gh secret set ALERT_EMAIL_KEY  --repo <owner>/<repo>   # a Resend API key
```

`ALERT_EMAIL_FROM` is optional and defaults to the alerts address on the sending
domain.

## The incident this came out of

**1 September 2026, roughly five hours, undetected.**

The probe called `begin` and walked away — the one thing a caller must not do.
The lease expired unreported, the worker correctly recorded `indeterminate`, and
the default policy for that state is `block`. Every later probe of the same day
was therefore refused. **The monitoring broke itself by using the product exactly
as designed**, and nobody noticed, because the only notification was GitHub
emailing the repository owner about a failed workflow.

Three separate faults, each worth keeping in mind:

1. **A probe that drives the product must drive all of it.** Beginning without
   reporting is not a partial test, it is a wrong one — it manufactures exactly
   the state the product is designed to punish. Fixed: the probe closes its lease.

2. **One key per day meant one probe in ninety-six tested the path that
   mattered.** The other ninety-five replayed a duplicate. The bug lived in the
   untested path. Fixed: a four-hour bucket, so the full path runs six times a
   day and monitoring self-heals within four hours instead of at midnight.

3. **Monitoring ran on an unclaimed workspace**, capped at 100 gated effects for
   its lifetime. At one probe a day that dies silently in about three months.
   Fixed: a claimed workspace on the free plan — which also means our own
   monitoring now experiences exactly what a customer on that plan experiences.

The remediation itself taught a fourth thing. Resolving the stuck effects as
`cancelled` was the honest description of what happened — nothing occurred and
nothing would — but `cancelled` means *this must not happen*, so `begin` then
correctly answered `denied` and monitoring stayed broken for a different reason.
When resolving a probe effect, `failed` is the state that is both honest and
retryable.

## Verified working — 1 September 2026

The chain has been proven end to end: GitHub Actions → Resend → a real inbox.
`Alert sent: Ratchet alert test — this is not an outage`, and it arrived.

Getting there took three attempts, and the reason is worth keeping. `ALERT_EMAIL`
held a **40-character alphanumeric string with no `@` in it** — a token or a
commit SHA, not an address. Nothing revealed that for two rounds, because the
only signal was a 422 from the mail provider *after* a send was attempted.

GitHub does not expose secret digests, so the value cannot be inspected from
outside; the workflow has to report on itself. Hence the **check_config** button,
which runs `alert.mjs check`: it prints the *shape* of the value — length,
has-at, has-whitespace, has-angle-brackets — and never the value, because these
logs are public. That turned a guessing game into one click.

> **When a secret is not working, do not iterate on how it is being set. Make
> the system describe what it actually holds.**

Setting it through the GitHub web UI rather than the shell is what finally
worked; shell quoting was the likely culprit throughout.

## What is still missing

- Nothing pages. See above.
- Nothing watches provisioning pressure: `provisionPressure()` exists and no
  caller reads it, so we would learn we were at the global ceiling from a
  complaint.
- No staging environment, so every deploy is tested in production.

---

## Replica health (added 1 Sep 2026)

The uptime workflow now fails — and therefore emails — on `replication` in the `/workerz`
body:

| Value | Meaning | Action |
|---|---|---|
| `ok` | Every standby is streaming and close behind | none |
| `degraded` | A standby is far behind, frozen, or missing | `flyctl logs -a ratchet-gate \| grep replication-watch` for which node and how far |
| `unobserved` | The watcher itself is not running | **Also a failure.** A watcher that is not running looks exactly like a healthy cluster |

`degraded` arrives with HTTP **200**, not 503. A sick replica is not worker death: leases are
still expiring and the gate is still correct. Returning 503 would invite the platform to
restart the one process that cannot fix a database.

Detail is deliberately absent from the response. The repository is public and `/workerz`
takes no credential, so which node and how far behind stays in the worker's logs.

Background and the reasoning behind the byte-distance measure:
[`INCIDENT_2026-09-01_FROZEN_STANDBY.md`](INCIDENT_2026-09-01_FROZEN_STANDBY.md).

---

## Cadence and what it costs (1 Sep 2026)

The repository went private, and private repositories meter GitHub Actions against
**2,000 free minutes a month**. Public repositories get unlimited minutes, so this cost
did not exist before and will disappear again if it is ever made public.

Measured, not estimated — median durations over the last 100 runs, billed rounded up to
the whole minute:

| Workflow | Median | Billed | At current cadence |
|---|---|---|---|
| `uptime` | 12s | 1 min | 48/day → **~1,440 min/month** |
| `backup` | 26s | 1 min | 1/day → ~30 min/month |
| `ci` | 102s | 2 min | per push → **the swing factor** |

The uptime probe was moved from every 15 minutes to **every 30** because the old cadence
billed ~2,880 minutes on its own — it would have exhausted the allowance around the third
week of every month and then stopped, taking CI and the nightly backup down with it.
Monitoring that silently switches itself off partway through the month is worse than
monitoring that runs half as often.

**It is still tight.** ~1,470 minutes go to uptime and backup, leaving ~530 for CI, which
is about 265 pushes a month. A heavy development day can use 50 of those. Watch it, and if
CI starts getting squeezed the next moves in order of preference are:

1. Move the uptime probe off GitHub to an external monitor — it needs no repository access,
   only HTTP, and this is the only item here that is not really CI work.
2. Drop the probe to hourly (~720 min/month), accepting 60-minute worst-case detection.
3. Pay for Actions minutes, or make the repository public again.

**What the cadence does not affect:** Fly's own health checks still hit `/healthz` every
15 seconds and restart an unhealthy machine. This workflow is the thing that notices the
*silent* failures — a worker that has stopped expiring leases, a replica that has stopped
replaying — which is why 30 minutes is tolerable: that damage accrues slowly, and nothing
is lost, only delayed.

