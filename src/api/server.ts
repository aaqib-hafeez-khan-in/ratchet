// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { buildApp } from './app.js';
import { config, assertProductionSafety } from '../lib/config.js';
import { migrate } from '../db/migrate.js';
import { registerCurrentKey } from '../domain/receipts.js';
import { closePool } from '../db/pool.js';
import { startActivityFlusher, stopActivityFlusher } from '../domain/activity.js';

const problems = assertProductionSafety();
if (problems.length > 0) {
  console.error('Refusing to start with unsafe production configuration:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const app = await buildApp();

try {
  if (process.env.MIGRATE_ON_BOOT !== 'false') {
    const applied = await migrate((m) => app.log.info(m));
    if (applied.length) app.log.info(`applied ${applied.length} migration(s)`);
  }
  startActivityFlusher();
  // Record the public half of the signing key before serving, so a receipt can
  // never be issued under a key nobody can look up.
  await registerCurrentKey();

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ratchet control plane listening on ${config.publicUrl}`);
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, draining`);
    await app.close();
    // Write buffered counters before the pool goes away.
    await stopActivityFlusher();
    await closePool();
    process.exit(0);
  });
}
