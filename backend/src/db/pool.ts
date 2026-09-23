import pg from 'pg';
import { config } from '../config/index.ts';
import { logger } from '../lib/logger.ts';

const { Pool } = pg;

export type QueryParams = ReadonlyArray<unknown> | undefined;

export interface DbStatus {
  configured: boolean;
  connected: boolean;
  error: string | null;
  version: string | null;
}

let pool: pg.Pool | null = null;
let poolError: string | null = null;

export function isDatabaseConfigured(): boolean {
  return config.databaseUrl.length > 0;
}

/**
 * Returns the shared pool, building it on first use. Throws when DATABASE_URL
 * is absent so callers cannot silently fall back to fake data.
 */
export function getPool(): pg.Pool {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseConnectTimeoutMs,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (err: Error) => {
      poolError = err.message;
      logger.error('postgres pool error', { error: err.message });
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
): Promise<pg.QueryResult<T>> {
  const started = Date.now();
  const result = await getPool().query<T>(text, params as unknown[]);
  logger.debug('query', { ms: Date.now() - started, rows: result.rowCount });
  return result;
}

/** Runs a callback inside a real transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<DbStatus> {
  if (!isDatabaseConfigured()) {
    return { configured: false, connected: false, error: 'DATABASE_URL not configured', version: null };
  }
  try {
    const res = await getPool().query<{ version: string }>('SELECT version() AS version');
    poolError = null;
    return {
      configured: true,
      connected: true,
      error: null,
      version: res.rows[0]?.version ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { configured: true, connected: false, error: message, version: null };
  }
}

export function lastPoolError(): string | null {
  return poolError;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
