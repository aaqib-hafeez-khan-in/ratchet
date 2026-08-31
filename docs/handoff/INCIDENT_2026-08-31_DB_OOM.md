# Incident: database OOM, full outage (~12 minutes)

**Cause: mine.** Scaling the control plane from one machine to two during an
audit pushed the database past its memory limit and took the whole service down.

## What happened

The audit found a real problem: with a single app machine, every deploy has a
window where nothing serves. For a service in the critical path of side effects
that is a genuine defect, so I scaled to two.

Each app instance opens its own pool of `DB_POOL_MAX` (10) connections. The
budget went from 20 connections (1 app + 1 worker) to 30. The database was a
**256MB** `shared-cpu-1x`, and each Postgres backend costs memory. It began
OOM-killing its own backends in a loop:

```
Out of memory: Killed process 714 (postgres)
Health check for your postgres role has failed
```

Both app machines then failed their `/readyz` check — correctly, since the
database really was unavailable — and Fly's proxy had no healthy candidate:
`could not find a good candidate within 40 attempts at load balancing`.

Every path returned nothing. Not a 500: no response at all.

## Why it was not caught sooner

`/readyz` checks the database and gates traffic properly. The health checking
was right. What was missing was any notion of a **connection budget**: nothing
anywhere related instance count × pool size to the database's capacity, so
scaling looked like a free operation.

The 256MB database was the underlying fragility. It had been running fine at 20
connections, which made it look adequate. It was not — it had no headroom, and
the first thing that asked for more took it down.

## Resolution

1. Scaled the app back to 1 to halve connection pressure. **Did not recover** —
   the database was already in an OOM loop and could not restart cleanly.
2. Raised the database to **1GB**. It came back healthy immediately.
3. Verified integrity, including that the **receipt hash chain still audits
   clean after an unclean shutdown** — Postgres crash-safety held and no
   evidence was corrupted.
4. Scaled back to 2 app machines, which now holds.

## The connection budget, written down so it is not rediscovered

```
connections = (app instances + worker instances) x DB_POOL_MAX
            = (2 + 1) x 10 = 30
```

Before changing instance count or `DB_POOL_MAX`, check the database can afford
it. A 256MB Postgres cannot hold 30 backends. Treat scaling the control plane
and sizing the database as one decision, not two.

## What this says about readiness

A 256MB database was never sufficient for a service that gates payments, and it
was one machine with no replica. Both were true before this incident; the
scaling merely revealed the first. Still outstanding: **the database is a single
machine with no replica and no tested restore.** That is a larger risk than the
one that fired today.
