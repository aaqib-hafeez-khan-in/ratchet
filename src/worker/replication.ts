import { getPool, type Db } from '../db/pool.js';
import { config } from '../lib/config.js';

/**
 * Watching the standbys.
 *
 * A standby sat frozen for over half an hour and nothing noticed. It was
 * streaming, its replication slot was healthy, its CPU was idle, and it
 * answered queries — it simply stopped applying what it received. It only
 * became visible because a migration added a column and one node did not have
 * it. Had the cluster failed over to that node, everything committed in the
 * meantime would have been gone, and the first sign would have been customers
 * reporting effects that had already been decided.
 *
 * Two things this taught, both encoded below.
 *
 * **Time lag lies on an idle database.** `replay_lag` reported 37 minutes on a
 * cluster doing almost no writes, which reads like a catastrophe; the same
 * statistic reads zero on a genuinely broken replica that has simply received
 * nothing new to be late about. Lag in TIME measures how long ago the last
 * applied transaction committed, which on a quiet system is a statement about
 * traffic, not health. Byte distance between the primary's WAL position and the
 * standby's replay position is the honest measure, so that is what is alerted
 * on.
 *
 * **Frozen is not the same as behind.** A replica pinned exactly at a segment
 * boundary while the primary moves on is the signature of a wedged receiver,
 * and it is dangerous long before the byte distance looks alarming. Successive
 * samples are compared so a replay position that does not move while the
 * primary advances is reported on its own, whatever the distance.
 */

export interface ReplicaState {
  name: string;
  state: string;
  bytesBehind: number;
  /** True when replay has not advanced since the previous sample. */
  frozen: boolean;
}

export interface ReplicationReport {
  /** Replication is only observable from the primary; on a standby we abstain. */
  observable: boolean;
  replicas: ReplicaState[];
  problems: string[];
}

/** Last replay position seen per replica, to tell "frozen" from merely "behind". */
const lastReplay = new Map<string, string>();

interface Row {
  application_name: string;
  state: string;
  replay_lsn: string | null;
  bytes_behind: string | null;
}

export async function checkReplication(db: Db = getPool()): Promise<ReplicationReport> {
  // pg_stat_replication is empty on a standby, and an empty result there means
  // "cannot see" rather than "no replicas". Treating those the same would make
  // this check report perfect health from the one place it can observe nothing.
  const { rows: [role] } = await db.query<{ in_recovery: boolean }>(
    'SELECT pg_is_in_recovery() AS in_recovery');
  if (role?.in_recovery !== false) {
    return { observable: false, replicas: [], problems: [] };
  }

  const { rows } = await db.query<Row>(
    `SELECT application_name, state, replay_lsn::text AS replay_lsn,
            pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::text AS bytes_behind
       FROM pg_stat_replication`);

  const replicas: ReplicaState[] = [];
  const problems: string[] = [];

  for (const r of rows) {
    const name = r.application_name || 'unnamed';
    const behind = Math.max(0, Number(r.bytes_behind ?? 0));
    const previous = lastReplay.get(name);
    // Frozen only counts when there is something to be late for: the primary
    // must have moved on while this replica did not.
    const frozen = previous !== undefined && previous === r.replay_lsn && behind > 0;
    if (r.replay_lsn) lastReplay.set(name, r.replay_lsn);

    replicas.push({ name, state: r.state, bytesBehind: behind, frozen });

    if (r.state !== 'streaming') {
      problems.push(`replica ${name} is "${r.state}", not streaming`);
    }
    if (frozen) {
      problems.push(
        `replica ${name} has not replayed anything since the last check while the `
        + `primary advanced (${mb(behind)} MB behind) — a wedged receiver looks exactly `
        + 'like this, and a restart of that node is what cleared it last time');
    } else if (behind > config.worker.replicaLagAlertBytes) {
      problems.push(
        `replica ${name} is ${mb(behind)} MB behind (threshold `
        + `${mb(config.worker.replicaLagAlertBytes)} MB)`);
    }
  }

  // Losing a replica outright is silent otherwise: the row simply stops being
  // there, and a shrinking list reads the same as a healthy short one.
  const expected = config.worker.expectedReplicas;
  if (expected > 0 && rows.length < expected) {
    problems.push(`only ${rows.length} of ${expected} expected replicas are connected`);
  }

  return { observable: true, replicas, problems };
}

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);

/** Reset between tests; the frozen check is stateful by nature. */
export function resetReplicationState(): void {
  lastReplay.clear();
}
