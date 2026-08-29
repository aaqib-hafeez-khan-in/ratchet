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
import { sweepExpiredLeases, collectExpiredEffects, collectStaleRecords } from './reaper.js';
import { deliverDue } from './webhooks.js';

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
function loop(name: string, intervalMs: number, fn: () => Promise<number | void>) {
  let busy = false;
  const tick = async () => {
    if (busy || !running) return;
    busy = true;
    try {
      const n = await fn();
      if (typeof n === 'number' && n > 0) log('info', `${name} processed`, { count: n });
    } catch (err) {
      log('error', `${name} failed`, { err: (err as Error).message });
    } finally {
      busy = false;
    }
  };
  timers.push(setInterval(tick, intervalMs));
  void tick();
}

async function main() {
  await getPool().query('SELECT 1');
  log('info', 'worker started', {
    leaseSweepIntervalMs: config.worker.leaseSweepIntervalMs,
    webhookPollIntervalMs: config.worker.webhookPollIntervalMs,
  });

  loop('lease-sweep', config.worker.leaseSweepIntervalMs, () => sweepExpiredLeases());
  loop('webhook-delivery', config.worker.webhookPollIntervalMs, () => deliverDue());
  loop('retention-gc', config.worker.gcIntervalMs, async () => {
    const effects = await collectExpiredEffects();
    const stale = await collectStaleRecords();
    return effects + stale.sessions + stale.deliveries;
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log('info', `${sig} received, stopping`);
    running = false;
    for (const t of timers) clearInterval(t);
    await closePool();
    process.exit(0);
  });
}

main().catch((err) => {
  log('error', 'worker failed to start', { err: (err as Error).message });
  process.exit(1);
});
