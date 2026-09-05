// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(log: (m: string) => void = console.log): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Everything runs in ONE transaction holding a TRANSACTION-scoped advisory
    // lock.
    //
    // The lock must be transaction-scoped, not session-scoped: a managed
    // Postgres endpoint is usually PgBouncer in transaction-pooling mode, where
    // a session-level lock is a correctness bug — the connection returns to the
    // pool while the caller still believes it holds the lock. A
    // pg_advisory_xact_lock is released with the transaction, so it is correct
    // through a pooler and directly.
    //
    // Wrapping all migrations in one transaction also makes them all-or-nothing
    // rather than leaving a half-migrated schema behind on failure. Postgres
    // DDL is transactional, so this costs nothing. It does rule out
    // CREATE INDEX CONCURRENTLY, which cannot run inside a transaction; if that
    // is ever needed, it belongs in a separately-flagged migration.
    await client.query('BEGIN');
    // Migrations can legitimately outlive the pool's statement timeout.
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x7261_7463]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
      log(`migrated ${file}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return applied;
}

/** Drops and recreates the public schema. Test/dev only. */
export async function resetSchema(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSchema is not permitted in production');
  }
  const pool = getPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const cmd = process.argv[2] ?? 'up';
  try {
    if (cmd === 'reset') { await resetSchema(); console.log('schema reset'); }
    const applied = await migrate();
    console.log(applied.length ? `applied ${applied.length} migration(s)` : 'already up to date');
  } catch (err) {
    console.error('migration failed:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
