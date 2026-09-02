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
  /**
   * False when this process cannot see replication at all — it is running on a
   * standby, or its role may not read the statistics. Abstaining is not the
   * same as a clean bill of health, and the two must never be conflated.
   */
  observable: boolean;
  /** Why nothing was observed, when nothing was. */
  blindReason?: 'standby' | 'not_permitted';
  replicas: ReplicaState[];
  problems: string[];
}

/** Last replay position seen per replica, to tell "frozen" from merely "behind". */
const lastReplay = new Map<string, string>();

/** Consecutive samples a slot has been inactive, to tell "gone" from "restarting". */
const slotIdle = new Map<string, number>();

/**
 * How many samples an inactive slot must persist before it is reported. A slot
 * goes inactive whenever its replica restarts, which is routine; one that stays
 * inactive belongs to a replica that is not coming back.
 */
const SLOT_IDLE_SAMPLES = 5;

interface Row {
  application_name: string;
  state: string | null;
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
    return { observable: false, blindReason: 'standby', replicas: [], problems: [] };
  }

  const { rows } = await db.query<Row>(
    `SELECT application_name, state, replay_lsn::text AS replay_lsn,
            pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::text AS bytes_behind
       FROM pg_stat_replication`);

  // Postgres shows the ROWS of pg_stat_replication to anyone but blanks the
  // columns for a role without pg_read_all_stats. The result is a watcher that
  // sees replicas whose every field is null: it reported "not streaming" about
  // two perfectly healthy standbys, and — far worse — could never have seen real
  // lag, because the position it compares was null too.
  //
  // A monitor that invents problems gets muted, and a muted monitor is why this
  // whole file exists. Say plainly that nothing can be seen.
  if (rows.length > 0 && rows.every((r) => r.replay_lsn === null && r.state === null)) {
    return {
      observable: false, blindReason: 'not_permitted', replicas: [],
      problems: ['replication cannot be read by this database role — '
        + 'GRANT pg_read_all_stats TO the application role, or replica health is unknown'],
    };
  }

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

    replicas.push({ name, state: r.state ?? 'unknown', bytesBehind: behind, frozen });

    if (r.state === null) {
      // Mixed visibility is not a thing worth guessing about.
      problems.push(`replica ${name} reports no state — this role may not read replication statistics`);
    } else if (r.state !== 'streaming') {
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

  // A slot outlives the replica it was made for.
  //
  // Destroying a node on 2 Sep left `repmgr_slot_1356046962` behind, inactive.
  // An inactive slot keeps pinning WAL on the primary — bounded here by
  // max_slot_wal_keep_size at 2 GB, but that bound is a disk-full backstop, not
  // a feature. Nothing else notices, which is the whole reason this file exists.
  const { rows: slots } = await db.query<{ slot_name: string; active: boolean }>(
    "SELECT slot_name, active FROM pg_replication_slots WHERE slot_type = 'physical'");
  const liveSlots = new Set(slots.map((x) => x.slot_name));
  for (const name of [...slotIdle.keys()]) {
    if (!liveSlots.has(name)) slotIdle.delete(name);
  }
  for (const slot of slots) {
    if (slot.active) { slotIdle.set(slot.slot_name, 0); continue; }
    const n = (slotIdle.get(slot.slot_name) ?? 0) + 1;
    slotIdle.set(slot.slot_name, n);
    if (n >= SLOT_IDLE_SAMPLES) {
      problems.push(
        `replication slot ${slot.slot_name} has been inactive for ${n} checks — it is `
        + 'still pinning WAL on the primary. If its replica is gone for good, drop it with '
        + `pg_drop_replication_slot('${slot.slot_name}')`);
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
  slotIdle.clear();
}
