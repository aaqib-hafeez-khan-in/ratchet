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

## What is still missing

- Nothing pages. See above.
- Nothing watches provisioning pressure: `provisionPressure()` exists and no
  caller reads it, so we would learn we were at the global ceiling from a
  complaint.
- No staging environment, so every deploy is tested in production.
