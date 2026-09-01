# Incident — a standby stopped replaying, and nothing noticed

**Date:** 1 Sep 2026
**Severity:** no customer impact; data loss was one failover away
**Found by:** deploying migration 028, entirely by accident

---

## What happened

A Postgres standby (`857597a4492d58`) stopped applying WAL at **17:31 UTC**. It was
discovered at **18:05**, 34 minutes later, and only because a schema change made the
divergence visible: a query for the new `email_verified_at` column succeeded on two nodes
and failed on the third.

At discovery the node was **~590 MB of WAL behind** the primary and holding stale data —
115 workspaces against the primary's 116.

## Why nothing caught it

Every surface reported health, and each one was telling the truth about the wrong thing.

| Surface | Said | Why it was useless here |
|---|---|---|
| `/healthz`, `/readyz` | 200 | Control plane, not the cluster |
| `/workerz` | 200, all loops | The worker was fine |
| Fly health check | flapping "resource limits" | Generic and misleading — the node was idle at 0.39 load |
| `pg_stat_replication.state` | `streaming` | It *was* receiving. It just was not applying |
| `pg_replication_slots` | `reserved`, 1.5 GB headroom | The slot was healthy; the replica was not |
| `pg_stat_activity` | `RecoveryWalStream` | Reads as "waiting for WAL", i.e. idle and normal |

Nothing in the entire stack watched whether a standby holds the same data as the primary.

## The measurement that lies

`replay_lag` read **37 minutes**, which sounds like the alarm that should have fired. It is
not usable:

- It measures how long ago the last *applied transaction committed*. On a quiet database
  that is a statement about traffic, not about health.
- It reads near zero on a genuinely broken replica that has received nothing new to be late
  about.

**Byte distance between the primary's WAL position and the standby's replay position** is
the honest measure, and it is what `replication-watch` alerts on.

There is a second signature worth naming separately: this node was pinned at exactly
`3/B3000000`, a segment boundary, while the primary moved on. A replay position that does
not advance across successive samples is a **wedged receiver**, and it is dangerous long
before the byte distance looks alarming. That is reported on its own.

## Resolution

`flyctl machines restart 857597a4492d58` cleared it. Replay resumed immediately (350 MB in
the first minute) and the node caught up fully in ~25 minutes. The replication slot had
preserved its position, so nothing needed rebuilding.

Final state — all three nodes agreeing:

```
857597a4492d58  standby | has column | 116 workspaces
d89359da0e5118  PRIMARY | has column | 116 workspaces
7845455b310328  standby | has column | 116 workspaces
```

## What changed

- **`src/worker/replication.ts`** — samples `pg_stat_replication` from the primary.
  Reports on byte distance, on a frozen replay position, on a replica that is connected but
  not streaming, and on a replica that has disappeared (when `EXPECTED_REPLICAS` is set).
- **Abstains on a standby.** `pg_stat_replication` is empty there, and reading that as "no
  replicas, all well" would make the check most confident exactly where it can see least —
  including right after a failover.
- **A finding is not a loop failure.** `recordOk` now carries a `note`. A watcher that
  successfully observes a sick cluster has done its job; recording that as a failure would
  age out its heartbeat, report the worker as stalled, and invite the platform to restart a
  process that cannot fix a database.
- **`/workerz` gains `replication: ok | degraded | unobserved`** alongside its 200. One
  word — the repository is public and the endpoint takes no credential, so which node and
  how far behind stays in the worker's logs.
- **`unobserved` is a failure in the uptime probe, not a pass.** A watcher that is not
  running looks exactly like a healthy cluster unless that is said out loud.

## Two bugs the tests then found

- **`EXPECTED_REPLICAS` was read at module load.** Import order would have decided the
  value for the whole process — the same trap that caught a provisioning limit earlier.
  Now a getter.
- **A resolved problem stayed on display.** The heartbeat throttle dropped the clearing
  write, so an alarm would have outlived its cause. Any *change* in the finding now bypasses
  the throttle, in both directions.

## The watcher's own false positive, caught on staging

Its first deploy reported `degraded` against a healthy cluster: *"replica
7845455b310328 is 'null', not streaming"*, about two standbys that were streaming at 0 and
72 KB behind.

Postgres shows the **rows** of `pg_stat_replication` to any role but blanks the **columns**
for one lacking `pg_read_all_stats`. Production's role is superuser and saw everything;
staging's `ratchet_staging` role was not, so every field came back null.

Worse than the noise: with `replay_lsn` null the comparison was against nothing, so the
check could never have detected real lag either. It would have been a monitor that cried
wolf while blind.

Fixed in two places:

- `checkReplication` detects blanked columns and returns `observable: false` with
  `blindReason: 'not_permitted'` and a message naming the grant, instead of inventing
  problems about healthy nodes.
- `GRANT pg_read_all_stats TO ratchet_staging` — **required for any new database role**, or
  replica health silently becomes unobservable. Note this when rebuilding an environment.

## It recurred the same day — and the cause is the hardware

At 23:36 UTC the alerting added that afternoon fired against production for the first
time: `replica 857597a4492d58 is 416.0 MB behind (threshold 256.0 MB)`. Ground truth
agreed — the other standby was 624 bytes behind, this one 436,208,240.

**The monitoring worked.** The morning's occurrence went 34 minutes undetected and was
found by accident during a migration. This one was caught automatically, by an email,
within hours of being built.

**The cause is CPU steal.** Comparing `/proc/stat` across the two standbys, which run
identical machine specs:

| Node | Lifetime CPU steal |
|---|---|
| `857597a4492d58` | **23.5%** (476,496 of 2,031,059 ticks) |
| `7845455b310328` | 0.2% (18,124 of 7,651,711 ticks) |

Steal is CPU time the hypervisor gave to another tenant. WAL replay is single-threaded
and CPU-bound, so a node losing a quarter of its CPU cannot keep pace with a primary
losing none. That is also why Fly's health check kept reporting "hit resource limits"
while `top` showed an idle machine: the VM is not busy, it is *starved*.

**This makes a restart the wrong fix.** `flyctl machines restart` keeps the machine on the
same physical host, so it inherits the same noisy neighbours — which is exactly why the
problem returned roughly five hours after the morning's restart. The node needs to be
destroyed and recreated so it is scheduled somewhere else.

Circumstantial support: this machine's volume was created ~33 hours before the other
two, which were rebuilt when the cluster was expanded. It is the only original node, and
the only one with this behaviour.

### Doing the rebuild

Not done at the time of writing, because it is deliberate work rather than an emergency:

- **Headroom.** `max_slot_wal_keep_size` is 2 GB and the slot had 1,632 MB remaining,
  giving roughly 19 hours at the observed rate before invalidation.
- **Quorum.** Removing a node drops the cluster to two, and a two-node repmgr cluster
  cannot form a majority — automatic failover is degraded for the duration of the rebuild.
  That is an acceptable window to open deliberately, and a bad one to stumble into at
  midnight on a solo-operated service.
- **It is now monitored.** Further degradation raises an alert rather than hiding.

The interim mitigation is another restart, which recovers the lag within about twenty
minutes and buys hours, not days.

## Still open

- **Why it wedged is now known: CPU steal, 23.5% against a twin's 0.2%.** See the section
  above. The remaining action is to destroy and recreate the machine so it is scheduled on
  a different host; restarting is a treadmill.
- **`max_slot_wal_keep_size` is 2 GB.** This node used ~590 MB of that reserve. A freeze
  lasting a few hours under real write volume would invalidate the slot, at which point the
  standby can only be rebuilt. The 256 MB alert threshold exists to leave room to act.
- **The production role is a superuser.** That is why production could read the statistics
  without a grant, and it is not a good reason to leave it that way. Narrowing it needs care
  around migrations, which run on boot, so it is recorded rather than changed here.

