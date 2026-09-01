# Worker liveness

*Added 31 August 2026. Migration 023. `src/worker/heartbeat.ts`, `GET /workerz`.*

## The failure this exists for

CLAUDE.md §10 says deploying the worker as anything other than a long-running
process is "the single most damaging mistake available in this codebase." That
was true and documented — but nothing **detected** it.

If the worker stops, leases never expire. Effects stay `pending` for ever, and
every subsequent caller is told `in_flight` and waits. No error is raised, no
alert fires, and the gate looks perfectly healthy from outside. The system is
silently broken for every key whose holder crashed.

## Crash is the easy case

A crashed worker gets restarted by the platform. The dangerous case is a
**wedge**: the process alive, the logs quiet, one loop stuck inside a query that
never returns.

The old `loop()` used a `busy` flag: `if (busy) return`. A tick that never
resolves leaves it set for ever, so that loop never runs again — no exception,
no exit, nothing in the logs. Fly sees a healthy process and leaves it alone.

Two changes follow:

**Heartbeats record completion, not attempts.** Per loop, not per process. A
loop that starts and never finishes goes stale, because going stale is the only
signal it will ever give.

**The worker kills itself when wedged.** `startWatchdog()` checks every 30s
whether any loop has been mid-tick longer than its staleness window and, if so,
logs loudly and exits. A supervised container that dies gets replaced; one that
sits there half-working does not.

## Thresholds

`staleAfterMs(interval) = max(interval × 10, 120s)`

Generous on purpose. A slow sweep is normal, and an alarm that cries wolf is an
alarm nobody reads. The floor stops a 2-second loop from getting a 20-second
window.

## `GET /workerz`

200 when every loop is fresh, **503** when one has stalled or none has ever run.
Unauthenticated, so a monitor needs no credential, and terse — loop names and
staleness, never instance identifiers.

**It is deliberately not `/readyz`.** `/readyz` decides whether an API machine
receives traffic, and a stalled worker must never take the control plane
offline: the gate works perfectly without a worker, it just stops expiring
leases. Coupling them would turn a recoverable stall into an outage. There is a
test asserting `/workerz` can be 503 while `/readyz` and `/healthz` stay 200.

"Never started" and "stalled" are reported distinctly, because *not deployed*
and *stopped* need different fixes.

## Reaching a person

- **Console**: a red banner on every panel while the worker is stalled or has
  never checked in. That is where someone will be looking when they finally
  notice something is odd.
- **External monitor**: point any uptime service at
  `https://ratchetgate.com/workerz`. This is the one alert that cannot come from
  the worker itself — a dead worker cannot report its own death, and the alert
  emails are delivered by that same worker.

**This is still not set up.** Until an external monitor watches `/workerz`,
detection depends on someone opening the console.

## Cost

One write per loop at most every 15 seconds, not per tick — a 2-second loop
would otherwise be 30 writes a minute. The throttle records a *successful*
write, so one transient database error cannot blank out the next fifteen seconds
of heartbeats and make a blip look like the start of a stall.

Several replicas share one row per loop. That is the right meaning: any healthy
replica keeps it fresh, and the question being asked is "is this work being done
by someone", not "is machine X alive".

## Not done

- Nothing alerts on `/workerz` automatically; it needs an external monitor.
- The watchdog detects a loop stuck **mid-tick**. A loop whose interval timer
  itself stopped firing — a corrupted event loop — would show as stale in the
  heartbeat table but would not trigger the watchdog's exit.
- No history: only the current state is stored, so "it stalls every night at
  4am" is not a question this can answer yet.
