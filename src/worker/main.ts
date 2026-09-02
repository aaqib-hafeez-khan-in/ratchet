/**
 * Ratchet worker.
 *
 * The control plane is stateless and can run anywhere, including serverless.
 * This process cannot: it must keep running to expire leases and deliver
 * webhooks whether or not a request is in flight. Deploy it as a long-running
 * container, never as a serverless function.
 *
 * Multiple replicas are safe — every claim uses FOR UPDATE SKIP LOCKED.
 */
import { config, assertProductionSafety } from '../lib/config.js';
import { closePool, getPool } from '../db/pool.js';
import { drainExpiredLeases, collectExpiredEffects, collectStaleRecords } from './reaper.js';
import { chainPendingReceipts, pruneReceipts } from '../domain/receipts.js';
import { refreshSurgeBaselines } from '../domain/circuit.js';
import { gcWindows as gcFeedbackWindows } from '../domain/feedback.js';
import { gcProvisionWindows } from '../domain/provisioning.js';
import { gcRunBudgets } from '../domain/run-budget.js';
import { deliverDue } from './webhooks.js';
import { watchChainOnce, expireQuotes } from './chain.js';
import { deliverEmails, generateAlerts } from './email.js';
import { checkReplication } from './replication.js';
import { runRecharges } from './recharge.js';
import { startActivityFlusher, stopActivityFlusher } from '../domain/activity.js';
import { recordOk, recordFailure, staleAfterMs } from './heartbeat.js';
import { randomUUID } from 'node:crypto';

const problems = assertProductionSafety();
if (problems.length > 0) {
  console.error('Refusing to start with unsafe production configuration:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, ts: new Date().toISOString(), svc: 'worker', msg, ...extra }));

let running = true;
const timers: NodeJS.Timeout[] = [];

/**
 * Run `fn` forever on an interval, never overlapping with itself and never
 * letting one failure kill the loop.
 */
const INSTANCE = process.env.FLY_MACHINE_ID ?? randomUUID().slice(0, 12);

/** Every loop, so the watchdog can see which of them has stopped finishing. */
const loops: Array<{ name: string; intervalMs: number; busySince: number | null }> = [];

type Tick = number | void | { count?: number; note?: string };

function loop(name: string, intervalMs: number, fn: () => Promise<Tick>) {
  const self = { name, intervalMs, busySince: null as number | null };
  loops.push(self);

  const tick = async () => {
    // busySince doubles as the busy flag and as evidence for the watchdog: a
    // tick that never returns leaves a timestamp behind, which is the only
    // trace a wedged loop ever produces.
    if (self.busySince !== null || !running) return;
    self.busySince = Date.now();
    try {
      const r = await fn();
      const n = typeof r === 'number' ? r : r?.count;
      const note = typeof r === 'object' && r !== null ? r.note : undefined;
      if (typeof n === 'number' && n > 0) log('info', `${name} processed`, { count: n });
      if (note) log('error', `${name} found a problem`, { detail: note });
      await recordOk(name, INSTANCE, intervalMs, undefined, note).catch(() => {});
    } catch (err) {
      const message = (err as Error).message;
      log('error', `${name} failed`, { err: message });
      // Heartbeat failures must never mask the failure being reported.
      await recordFailure(name, INSTANCE, intervalMs, message).catch(() => {});
    } finally {
      self.busySince = null;
    }
  };
  timers.push(setInterval(tick, intervalMs));
  void tick();
}

/**
 * Exit when a loop has stopped finishing.
 *
 * A crashed worker is the easy case: the platform restarts it. The dangerous
 * one is a wedge — the process alive, the logs quiet, one loop stuck inside a
 * query that never returns. Its tick never completes, so it never runs again
 * and never complains, and leases quietly stop expiring.
 *
 * Exiting is the recovery. A supervised container that dies gets replaced; one
 * that sits there half-working does not. The threshold is the same generous one
 * used to judge staleness, so a slow sweep is never mistaken for a stuck one.
 */
function startWatchdog() {
  const timer = setInterval(() => {
    if (!running) return;
    const now = Date.now();
    for (const l of loops) {
      if (l.busySince === null) continue;
      const stuckFor = now - l.busySince;
      if (stuckFor > staleAfterMs(l.intervalMs)) {
        log('error', 'loop wedged — exiting so the platform restarts this worker', {
          loop: l.name, stuckForMs: stuckFor, intervalMs: l.intervalMs,
        });
        // Leases stop expiring while this is true. Better to die loudly.
        process.exit(1);
      }
    }
  }, 30_000);
  timer.unref?.();
  timers.push(timer);
}

async function main() {
  await getPool().query('SELECT 1');
  log('info', 'worker started', {
    leaseSweepIntervalMs: config.worker.leaseSweepIntervalMs,
    webhookPollIntervalMs: config.worker.webhookPollIntervalMs,
  });

  startActivityFlusher();
  startWatchdog();

  loop('lease-sweep', config.worker.leaseSweepIntervalMs, () => drainExpiredLeases());
  loop('webhook-delivery', config.worker.webhookPollIntervalMs, () => deliverDue());
  // Only runs when the operator has configured a receiving address. The
  // watcher reads the chain and never holds a key.
  if (config.crypto.solanaDestination && config.crypto.rpcUrl) {
    log('info', 'chain watcher enabled', { destination: config.crypto.solanaDestination });
    loop('chain-watch', config.crypto.pollIntervalMs, async () => {
      const r = await watchChainOnce();
      return r.credited;
    });
    loop('quote-expiry', 60_000, () => expireQuotes());
  } else {
    log('info', 'chain watcher disabled (no SOLANA_DESTINATION_ADDRESS / SOLANA_RPC_URL)');
  }

  // Two separate loops on purpose: a mail outage delays alerts but never loses
  // them, and a storm of effects cannot become a storm of provider requests.
  loop('email-delivery', config.email.pollIntervalMs, () => deliverEmails());
  // Digests current state rather than firing per event, which is what keeps
  // five hundred indeterminate effects to one email.
  loop('email-alerts', 5 * 60_000, () => generateAlerts());

  // What "normal" looks like for each effect type, so a relative surge
  // threshold has something to be a multiple of. Recomputed here rather than on
  // the request path: a median over a growing history is exactly the kind of
  // aggregate that must never sit in front of a decision.
  loop('surge-baseline', 15 * 60_000, () => refreshSurgeBaselines());

  // Money, so: infrequent, and the only loop here that spends any. Five
  // minutes is deliberate — a balance that just crossed a threshold is not an
  // emergency, and a tight loop around a payment API is how a bug becomes a
  // bank statement.
  loop('credit-recharge', 5 * 60_000, () => runRecharges());

  // Watching the database that is watching everything else. A standby froze for
  // over half an hour with every surface reporting health, and only a migration
  // exposed it — see src/worker/replication.ts.
  loop('replication-watch', config.worker.replicationCheckIntervalMs, async () => {
    const r = await checkReplication();
    return r.problems.length ? { note: r.problems.join('; ') } : {};
  });

  loop('retention-gc', config.worker.gcIntervalMs, async () => {
    const effects = await collectExpiredEffects();
    const stale = await collectStaleRecords();
    // One row per minute in which anyone submitted feedback. Small, but it
    // grows forever and nothing ever reads a window older than the current one.
    const windows = await gcFeedbackWindows();
    const provision = await gcProvisionWindows();
    // Wallets for runs nobody will look at again.
    const wallets = await gcRunBudgets();
    return effects + stale.sessions + stale.deliveries + stale.anonymous
         + windows + provision + wallets;
  });

  // Receipts are signed on the request path and linked here. Runs often,
  // because an unchained receipt is still individually verifiable but does not
  // yet prove that nothing around it was removed.
  loop('receipt-chain', 5_000, () => chainPendingReceipts());

  // Checkpoint-then-prune. Runs on the GC cadence because it deletes, and a
  // deletion bug should have a slow blast radius rather than a fast one.
  loop('receipt-prune', config.worker.gcIntervalMs, async () => {
    const r = await pruneReceipts(config.receiptRetentionDays);
    return r.pruned;
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log('info', `${sig} received, stopping`);
    running = false;
    for (const t of timers) clearInterval(t);
    await stopActivityFlusher();
    await closePool();
    process.exit(0);
  });
}

main().catch((err) => {
  log('error', 'worker failed to start', { err: (err as Error).message });
  process.exit(1);
});
