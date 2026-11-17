import pg from 'pg';
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool, types } = pg;

// BIGINT (int8, OID 20) and NUMERIC (OID 1700) are returned as strings by node-pg by default.
// Ids from this schema are always far below 2^53, so parse them as numbers. Without this,
// comparisons such as `reporter_id === user_id` and MongoDB `$in: [ids]` lookups silently fail.
types.setTypeParser(20, (v: string) => Number(v));
types.setTypeParser(1700, (v: string) => Number(v));

let pool: PgPool | null = null;

function buildSslOption(connectionString: string): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable' || mode === 'false' || mode === '0') return false;
  if (mode === 'require' || mode === 'true' || mode === '1') return { rejectUnauthorized: false };
  // Auto: local databases usually have no SSL, hosted ones (Supabase, Neon, ...) require it.
  try {
    const host = new URL(connectionString).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres' || host === 'db') {
      return false;
    }
  } catch {
    /* fall through */
  }
  return { rejectUnauthorized: false };
}

export function getPgPool(): PgPool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not defined. Copy .env.example to .env and set it.');
    }
    pool = new Pool({
      connectionString,
      ssl: buildSslOption(connectionString),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    });
    pool.on('error', (err) => {
      console.warn('[PostgreSQL pool warning]:', err.message);
    });
  }
  return pool;
}

/** Run a single statement on any pooled connection. Never use this for BEGIN/COMMIT. */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return getPgPool().query<T>(text, params);
}

export type Tx = {
  query: <T extends QueryResultRow = any>(text: string, params?: any[]) => Promise<QueryResult<T>>;
};

/**
 * Run `fn` inside a real transaction. All statements issued through `tx.query` are guaranteed to
 * use the SAME connection (a pool hands out a different connection per `pool.query`, so issuing
 * BEGIN/COMMIT through it does not give atomicity). Rolls back on any thrown error.
 */
export async function withTransaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
  const client: PoolClient = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (text, params) => client.query(text, params),
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Set transaction-local context read by the audit trigger (who made the change and why). */
export async function setAuditContext(tx: Tx, userId: number, remarks?: string | null) {
  await tx.query(`SELECT set_config('app.user_id', $1, true), set_config('app.remarks', $2, true)`, [
    String(userId),
    remarks ?? '',
  ]);
}

/** True for errors raised on purpose by our own PL/pgSQL (RAISE EXCEPTION) or by constraints. */
export function isClientDbError(err: any): boolean {
  return err && (err.code === 'P0001' || err.code === '23514' || err.code === '23503' || err.code === '23505');
}
