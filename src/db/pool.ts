import pg from 'pg';
import { config } from '../lib/config.js';

// BIGINT (OID 20) arrives as a string by default. All of our bigints are
// micro-USD or counters that stay far inside Number.MAX_SAFE_INTEGER
// (9.007e15 micro-USD is ~9 billion dollars), so parsing to number is safe
// and keeps arithmetic in the domain layer readable.
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      ssl: config.dbSsl ? { rejectUnauthorized: true } : undefined,
      application_name: 'ratchet',
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    pool.on('error', (err) => {
      // A pooled idle client died (e.g. database restart). Never crash the
      // process for this; the pool creates a replacement on next checkout.
      console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', err: err.message }));
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
