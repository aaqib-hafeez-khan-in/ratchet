# Load, capacity, and what actually breaks first

*31 August 2026. Reproduce with `npm run stress` (local) and `npm run probe:prod` (live).*

Every number here came from a run whose output is quoted. Nothing is extrapolated,
and nothing is from a run that was measuring rejections — both harnesses refuse to
report a percentile when any request came back non-2xx, because a page of fast
429s reads as excellent throughput and means the opposite.

---

## 1. Safety under load

`npm run stress 4` — 18 assertions, all held:

| Property | Result |
|---|---|
| 2,000 concurrent callers, one key | exactly **1** `execute`, 1 effect, 1 lease, 1 vendor key |
| Spend ceiling, 1,600 racing callers × 1,000 µUSD | exactly 100,000 spent against a 100,000 ceiling |
| Stale fencing token reporting | refused, HTTP 409 |
| Abandoned lease | → `indeterminate`; retry then `blocked` under the default policy |
| Same key, different payload | refused, `idempotency_key_reuse` |
| Cross-tenant reads, 400 probes under load | 0 non-404 |
| Same key in a different tenant | independent record |
| 1,200 interleaved begin+report | **0 deadlocks** |
| 800 replays of a succeeded effect | 1 decision, 1 result |
| 2,400 simultaneous requests vs. a 10-connection pool | 0 errors, queued |
| 300 simultaneous callers vs. a surge ceiling of 20 | exactly 20 executed, 280 denied, 1 breaker |

The lock ordering in CLAUDE.md §7 holds under real contention. Note the storm
result: contention on a single key is not slower than distinct keys, because
`beginEffect`'s unlocked pre-check means duplicates never take the workspace lock.

## 2. Latency

**Local** (`npx tsx scripts/bench.ts 1000`, Apple M5 Pro, in-process, local Postgres —
excludes network):

```
begin (new effect)         n=800   mean=3.04ms  p50=2.96  p95=3.54  p99=4.25
begin (duplicate replay)   n=800   mean=1.83ms  p50=1.78  p95=2.01  p99=2.62
report outcome             n=800   mean=1.47ms  p50=1.45  p95=1.71  p99=2.11
```

`begin (new effect)` rose from p50 2.52 ms after surge containment shipped: one
UPSERT into `effect_rate_windows` per genuinely new effect. Duplicates, replays
and reports are untouched, which is the path a retrying agent actually takes.

**Production** (`npm run probe:prod`, over the public internet to `sjc`):

```
begin (replay, sequential)     p50=  72ms  p95= 128ms  p99= 187ms
healthz (network floor)        p50=  40ms  p95= 104ms
effect read                    p50=  54ms
begin @ concurrency 15         p50= 137ms  p95= 234ms   63 rps
```

The floor is 40ms of network from the measuring machine to San Francisco. **The
gate itself costs roughly 30ms on top of the link.** An agent in the same region
sees far less; one on another continent sees the RTT, not the gate. There is one
region (`sjc`) and no read replicas, so this is the whole picture.

Do not publish the local numbers as product claims. Production is one
`shared-cpu-1x` instance; the M5 Pro figures describe the code, not the service.

## 3. Where the ceilings actually are

**Throughput plateaus near 680 rps locally**, and it is pool-bound, not CPU-bound:
`DB_POOL_MAX` defaults to 10. Raising it raises throughput and raises database
memory pressure in exact proportion — see the OOM incident. Do not raise it
without raising database memory first.

**Connection budget**: `(app instances + worker) × DB_POOL_MAX`. Today 2 × 10 +
10 = 30, against 17 in use and `max_connections = 300`.

> `max_connections = 300` on a 1 GB database is a standing hazard. 300 backends
> cannot fit in 1 GB, and the July OOM happened at 30 connections on a 256 MB
> machine. Nothing today opens that many because the client pool caps us — but
> the server would accept them.

**Reaper**: `sweepExpiredLeases` handles the oldest 50 per call. It drains at
**~1,340/second** measured. The worker used to call it once per 2s tick, capping
the `pending → indeterminate` transition at **25/second**; it now drains in
bounded batches, so a burst clears in a tick or two rather than minutes.

This was never a safety property — an unswept lease is still expired and nothing
hands out a second `execute`. It is how long the truth takes to become visible:
until an effect is swept it stays `pending`, so a caller retrying is told
`in_flight` and learns nothing.

## 4. Traps this measurement walked into

Recorded because both are easy to repeat:

1. **`/v1/effects/begin` hardcoded `max: 600`**, ignoring the plan, while the
   manifest published free=120 / pro=600 / scale=3000. A Scale customer was
   capped at a fifth of what they paid for, and a free workspace got five times
   its allowance on the most expensive route to serve. The bench script could
   not run at all because the hardcode also ignored `RATE_LIMIT_OVERRIDE` — the
   inability to measure was itself the symptom.

2. **The first stress run reported 779 rps at concurrency 256** that was 700
   × HTTP 402. The workspace had run out of credit. Both harnesses now refuse
   to print a percentile when any response was non-2xx.

## 5. Not yet measured

- Sustained load over hours (memory growth, connection churn, index bloat).
- Behaviour when the database fails over — there is no replica to fail over to.
- Webhook delivery under a large backlog.
- Anything from a region other than the one the measuring machine sits in.
