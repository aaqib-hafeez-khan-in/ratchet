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
      // statement_timeout and idle_in_transaction_session_timeout are NOT set
      // here. `pg` sends them as connection startup parameters, and PgBouncer
      // in transaction-pooling mode — what most managed Postgres endpoints put
      // in front of the database — rejects the connection outright with
      // "unsupported startup parameter". They are applied per-transaction in
      // withTx() instead, via SET LOCAL, which is pooler-safe and equally
      // effective for the queries that matter.
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

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Timeouts are applied here with SET LOCAL rather than as connection startup
 * parameters, so this works identically against a direct Postgres and behind a
 * transaction-pooling PgBouncer. SET LOCAL is scoped to the transaction and
 * released with it, so no state leaks back into the pool.
 */
export async function withTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    // One message, not two. These were separate query() calls and therefore two
    // full round trips before a transaction had done anything at all — paid by
    // every transactional endpoint, on every request. Postgres's simple-query
    // protocol runs the whole string in order, the SET LOCALs land inside the
    // block the leading BEGIN opened, and the block stays open afterwards, so
    // the semantics are identical.
    await client.query(
      'BEGIN; '
      + `SET LOCAL statement_timeout = ${config.statementTimeoutMs}; `
      + `SET LOCAL idle_in_transaction_session_timeout = ${config.idleInTxTimeoutMs}`);
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
