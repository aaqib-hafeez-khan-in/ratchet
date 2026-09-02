# Incident — a planned failover took production down for ~25 minutes

**Date:** 2 Sep 2026, 00:42–01:12 UTC
**Severity:** full outage of the control plane. **No data lost.**
**Cause:** a `flyctl postgres failover` that failed halfway and left two primaries

---

## What was being attempted, and why

The primary was measured at **89–91% CPU steal** — receiving roughly a tenth of the CPU it
asked for. The same starvation at 23.5% had already stopped a standby replaying WAL twice
that day (see [`INCIDENT_2026-09-01_FROZEN_STANDBY.md`](INCIDENT_2026-09-01_FROZEN_STANDBY.md)).
Moving the primary onto healthy hardware was correct and necessary.

Both standbys were rebuilt first, deliberately, so that whichever repmgr promoted would be
a healthy node — `flyctl postgres failover` takes no target argument. Both were verified at
0.0% steal and 0 bytes of lag, and a full backup was taken and *verified by restore*
immediately before.

## What happened

`flyctl postgres failover` promoted `d8d204df245618` to timeline 3, then failed its health
check, gave up, and restarted the old primary:

```
Error promoting new leader, restarting existing leader
Error: Failed to run failover: failed to wait for health checks to pass
```

The rollback was not a rollback. It left:

- `d89359da0e5118` — running as primary on timeline 2
- `d8d204df245618` — running as primary on timeline 3
- `849766b2d60938` — a standby still following the old primary, on timeline 2

**Two primaries.** Fly's image detected this and did the right thing: it wrote
`zombie.lock`, set `default_transaction_read_only = true` on every database, and refused to
start PgBouncer. That is a correct safety response — and it is also what took the control
plane down, because the app reaches Postgres through PgBouncer.

## Why it stayed down for 25 minutes

Each layer had to be understood before it could be cleared, and only the last one was
obvious in hindsight:

1. **Stale connection pools.** The app logged `pg idle client error: Connection terminated
   unexpectedly`. Restarting the app was necessary but not sufficient.
2. **The restart loop.** `flyctl machine restart` left machines stopped rather than
   restarted; they then hit `max restart count of 10` because every boot died in `migrate()`.
3. **Split brain.** Resolved by stopping the old primary. All three nodes held **identical
   data** — 118 workspaces, 226 effects — so there was no divergence to reconcile and no
   choice to agonise over. The surviving node was the newest timeline *and* the healthy
   hardware.
4. **Stale repmgr records** for the failed primary and the diverged standby, which kept
   PgBouncer from resolving a primary. Unregistered.
5. **`zombie.lock` / `readonly.lock`.** Cleared, then the node restarted cleanly.
6. **The one that was invisible:** clearing the lock files does **not** reset
   `default_transaction_read_only`, which Fly had set at the **database** level. A direct
   connection on 5433 reported `off`; only `pg_db_role_setting` showed the truth. Until this
   was found, the app connected successfully and then died on `CREATE TABLE in a read-only
   transaction`.

```sql
ALTER DATABASE ratchet_gate    RESET default_transaction_read_only;
ALTER DATABASE ratchet_staging RESET default_transaction_read_only;
```

## Outcome

Production recovered at 01:12. Full smoke passes; 119 workspaces and 227 effects, the extra
pair being the smoke test itself. **Nothing was lost.**

The cluster was rebuilt to three nodes from the surviving primary. Every node is now on
healthy hardware, which was the original goal:

| Node | Role | Steal | Before |
|---|---|---|---|
| `d8d204df245618` | primary | **0.0%** | 89–91% |
| `683d492c257308` | standby | 0.2% | — |
| `6835447a474308` | standby | 0.2% | — |

## What this changes

- **`EXPECTED_REPLICAS=2` is now set.** For twenty minutes the cluster ran on a single node
  with no redundancy while `/workerz` reported `replication: ok` — with the expectation
  unset, "no replicas" and "no problems" are the same answer. The check existed and was
  disabled by its own default. A test now pins it.
- **`flyctl postgres failover` is not safe to run unattended on this cluster.** It has no
  target argument, and its failure path leaves two primaries rather than restoring the
  starting state. If a primary must be moved again, prefer `repmgr standby switchover`,
  which coordinates the demotion — and expect to need the read-only reset above afterwards.
- **Do it in a window, with a verified backup, and expect the outage.** This was run as a
  "controlled" operation. It was controlled in preparation and uncontrolled in execution;
  the honest framing for next time is planned downtime, not a seamless switch.

## What went right

- The **verified backup taken 20 minutes earlier** meant the split brain was never
  frightening. It was never needed, which is the point of taking it.
- **Rebuilding both standbys first** meant the node that got promoted was healthy hardware.
  Had the failover been run against the original cluster, it would have promoted a
  20%-steal node and the outage would have bought nothing.
- **Checking that all three nodes held identical data before choosing** turned an
  irreversible-looking decision into an obvious one.
