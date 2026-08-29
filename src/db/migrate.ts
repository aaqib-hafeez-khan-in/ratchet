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
    // Serialize concurrent migrators (several API instances booting at once)
    // BEFORE touching the schema. `CREATE TABLE IF NOT EXISTS` is not itself
    // safe against a concurrent identical create — it races in the catalog.
    await client.query('SELECT pg_advisory_lock($1)', [0x7261_7463]);
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
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`migrated ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [0x7261_7463]).catch(() => {});
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
