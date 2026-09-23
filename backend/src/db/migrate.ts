import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.ts';
import { closePool, getPool, isDatabaseConfigured } from './pool.ts';
import { logger } from '../lib/logger.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL is not configured; cannot run migrations');
  }
  const dir = path.join(here, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const pool = getPool();
  const applied: string[] = [];
  const skipped: string[] = [];

  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const existing = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  const done = new Set(existing.rows.map((r) => r.version));

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      logger.info('migration applied', { file });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error('migration failed', { file, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  if (!config.databaseUrl) {
    process.stderr.write('DATABASE_URL is not configured. Set it in .env or the environment before migrating.\n');
    process.exit(2);
  }
  runMigrations()
    .then(async (result) => {
      process.stdout.write(`migrations applied: ${result.applied.length}, already present: ${result.skipped.length}\n`);
      await closePool();
    })
    .catch(async (err: unknown) => {
      process.stderr.write(`migration error: ${err instanceof Error ? err.message : String(err)}\n`);
      await closePool();
      process.exit(1);
    });
}
