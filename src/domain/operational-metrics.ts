import { getPool, type Db } from '../db/pool.js';

/**
 * Operating numbers, in a format a monitoring system can scrape.
 *
 * Distinct from `metrics.ts`, which answers commercial questions — activation,
 * retention — over a 30-day window from a CLI. These are the numbers an
 * operator wants on a dashboard at 3am, and the one that matters most is the
 * indeterminate rate.
 *
 * WHY THAT ONE. An effect becomes `indeterminate` when a lease expires with no
 * report: the agent took permission to do something and never came back to say
 * whether it worked. It is the leading indicator of agents crashing mid-action,
 * and it is invisible from every other signal — the API is healthy, the worker
 * is healthy, the database is fine, and somewhere a customer's refunds are
 * sitting in a state nobody has resolved. A rising indeterminate rate is the
 * closest thing this service has to a smoke alarm.
 *
 * WHAT IS DELIBERATELY ABSENT. Nothing here is per-workspace. Metrics are the
 * classic place a multi-tenant service leaks its customer list — a label like
 * `workspace_id="ws_abc"` on a public endpoint hands over the shape of the
 * business, and one on a private endpoint still ends up in a third-party
 * monitoring vendor. Everything below is an aggregate, and the tests assert it
 * stays that way.
 */

export interface OperationalMetrics {
  effectsByState: Record<string, number>;
  /** Effects created in the last hour and the last day, for a rate. */
  effectsCreated: { lastHour: number; lastDay: number };
  /**
   * Became indeterminate — the lease expired unreported. Windows only: a
   * lifetime total is published as effectsByState and is the wrong thing to
   * alert on, because it never comes back down.
   */
  indeterminate: { lastHour: number; lastDay: number };
  /** Holding a live lease right now: work an agent has permission to do. */
  leasesOutstanding: number;
  /** Waiting on a human. A rising number here is a queue nobody is serving. */
  awaitingApproval: number;
  webhooks: { pending: number; failed: number; deliveredLastDay: number };
  circuitsOpen: number;
  workers: { loops: number; stale: number };
  replicas: { connected: number; maxLagBytes: number } | null;
}

export async function collect(db: Db = getPool()): Promise<OperationalMetrics> {
  // One round trip. A scrape happens on a timer and should not turn into eight
  // separate queries against the same table.
  const { rows } = await db.query<{
    state: string; n: string; last_hour: string; last_day: string;
  }>(
    `SELECT state,
            count(*)                                                        AS n,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')  AS last_hour,
            count(*) FILTER (WHERE created_at > now() - interval '1 day')   AS last_day
       FROM effects GROUP BY state`);

  const byState: Record<string, number> = {};
  let createdHour = 0, createdDay = 0;
  for (const r of rows) {
    byState[r.state] = Number(r.n);
    createdHour += Number(r.last_hour);
    createdDay += Number(r.last_day);
  }

  // Indeterminate is counted by when it was UPDATED, not created: the effect
  // may have been created hours before its lease expired, and the question is
  // when it went bad, not when it started.
  const { rows: ind } = await db.query<{ last_hour: string; last_day: string }>(
    `SELECT count(*) FILTER (WHERE updated_at > now() - interval '1 hour') AS last_hour,
            count(*) FILTER (WHERE updated_at > now() - interval '1 day')  AS last_day
       FROM effects WHERE state = 'indeterminate'`);

  const { rows: leases } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM effects
      WHERE state = 'pending' AND lease_expires_at > now()`);

  const { rows: wh } = await db.query<{ pending: string; failed: string; delivered: string }>(
    `SELECT count(*) FILTER (WHERE state = 'pending')                          AS pending,
            count(*) FILTER (WHERE state = 'failed')                           AS failed,
            count(*) FILTER (WHERE delivered_at > now() - interval '1 day')    AS delivered
       FROM webhook_deliveries`);

  const { rows: circuits } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM circuit_breakers WHERE state = 'open'");

  const { rows: workers } = await db.query<{ loops: string; stale: string }>(
    `SELECT count(*) AS loops,
            count(*) FILTER (
              WHERE last_ok_at IS NULL
                 OR last_ok_at < now() - make_interval(secs => greatest(interval_ms / 1000 * 3, 30))
            ) AS stale
       FROM worker_heartbeats`);

  // Only the primary can see replication. On a standby this is null rather
  // than zero — "cannot see" and "none attached" are different answers, and
  // reporting the second when the first is true is how a dashboard lies.
  let replicas: OperationalMetrics['replicas'] = null;
  const { rows: role } = await db.query<{ in_recovery: boolean }>(
    'SELECT pg_is_in_recovery() AS in_recovery');
  if (role[0]?.in_recovery === false) {
    const { rows: rep } = await db.query<{ n: string; lag: string | null }>(
      `SELECT count(*) AS n,
              COALESCE(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0)::text AS lag
         FROM pg_stat_replication`);
    replicas = { connected: Number(rep[0]?.n ?? 0), maxLagBytes: Number(rep[0]?.lag ?? 0) };
  }

  return {
    effectsByState: byState,
    effectsCreated: { lastHour: createdHour, lastDay: createdDay },
    indeterminate: {
      lastHour: Number(ind[0]?.last_hour ?? 0),
      lastDay: Number(ind[0]?.last_day ?? 0),
    },
    leasesOutstanding: Number(leases[0]?.n ?? 0),
    awaitingApproval: byState.awaiting_approval ?? 0,
    webhooks: {
      pending: Number(wh[0]?.pending ?? 0),
      failed: Number(wh[0]?.failed ?? 0),
      deliveredLastDay: Number(wh[0]?.delivered ?? 0),
    },
    circuitsOpen: Number(circuits[0]?.n ?? 0),
    workers: { loops: Number(workers[0]?.loops ?? 0), stale: Number(workers[0]?.stale ?? 0) },
    replicas,
  };
}

/** Every state the machine can be in, so a gauge does not vanish when it hits zero. */
const EFFECT_STATES = ['pending', 'succeeded', 'failed', 'indeterminate',
                       'denied', 'cancelled', 'awaiting_approval'] as const;

/**
 * Prometheus text exposition.
 *
 * Written by hand rather than pulled from a client library: the output is
 * forty lines of a stable, documented format, and a dependency that runs in
 * the request path of a public service has to earn its place.
 *
 * Every series is emitted even at zero. A gauge that disappears when it reaches
 * zero produces a gap in a graph rather than a flat line, and an alert on
 * `absent()` then fires for a system that is working perfectly.
 */
export function render(m: OperationalMetrics): string {
  const out: string[] = [];
  const metric = (name: string, help: string, type: 'gauge' | 'counter',
                  samples: [string, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) out.push(`${name}${labels} ${value}`);
  };

  metric('ratchet_effects_total',
    'Effect records by state.', 'gauge',
    EFFECT_STATES.map((s) => [`{state="${s}"}`, m.effectsByState[s] ?? 0]));

  metric('ratchet_effects_created',
    'Effects created recently, by window.', 'gauge',
    [['{window="1h"}', m.effectsCreated.lastHour],
     ['{window="24h"}', m.effectsCreated.lastDay]]);

  // Rate windows only. There WAS a {window="all"} series here, and it was a
  // trap: a lifetime total only ever climbs, so an alert on it fires once and
  // then stays lit for ever, and it reads high on any instance that has ever
  // been load-tested. The current standing count is already published as
  // ratchet_effects_total{state="indeterminate"}, which is the gauge to graph;
  // these two are what to alert on.
  metric('ratchet_effects_indeterminate',
    'Effects whose lease expired with no report, within a window — the leading '
    + 'indicator of agents crashing mid-action, and the number worth alerting on. '
    + 'Alert on a sustained non-zero 24h value.', 'gauge',
    [['{window="1h"}', m.indeterminate.lastHour],
     ['{window="24h"}', m.indeterminate.lastDay]]);

  metric('ratchet_leases_outstanding',
    'Effects holding a live lease: work an agent currently has permission to do.',
    'gauge', [['', m.leasesOutstanding]]);

  metric('ratchet_awaiting_approval',
    'Effects waiting on a human decision. A rising number is an unserved queue.',
    'gauge', [['', m.awaitingApproval]]);

  metric('ratchet_webhook_deliveries',
    'Webhook delivery backlog and outcomes.', 'gauge',
    [['{state="pending"}', m.webhooks.pending],
     ['{state="failed"}', m.webhooks.failed],
     ['{state="delivered_24h"}', m.webhooks.deliveredLastDay]]);

  metric('ratchet_circuits_open',
    'Circuit breakers currently open, i.e. surge containment actively refusing work.',
    'gauge', [['', m.circuitsOpen]]);

  metric('ratchet_worker_loops',
    'Worker loops checked in, and how many have stopped completing.', 'gauge',
    [['{state="total"}', m.workers.loops], ['{state="stale"}', m.workers.stale]]);

  // Null means this process is on a standby and genuinely cannot see
  // replication. Emitting 0 would report a healthy-looking "no lag" from the
  // one place that has no idea.
  if (m.replicas) {
    metric('ratchet_replicas_connected',
      'Streaming replicas attached to the primary.', 'gauge',
      [['', m.replicas.connected]]);
    metric('ratchet_replica_lag_bytes',
      'Furthest a replica has fallen behind the primary, in bytes. Byte distance '
      + 'rather than time: on a quiet database, time lag measures traffic, not health.',
      'gauge', [['', m.replicas.maxLagBytes]]);
  }

  return out.join('\n') + '\n';
}
