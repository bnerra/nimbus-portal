import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * A tiny migration runner (~50 lines) instead of a library, so you can see
 * exactly how migrations work. Real tools (node-pg-migrate, Flyway, Prisma
 * Migrate) do the same thing with more features.
 *
 * The idea:
 * - Each schema change is a numbered .sql file in apps/api/migrations/.
 * - A `schema_migrations` table records which files have already run.
 * - On each run we apply only the new files, in order, each in a transaction.
 *
 * Rule: never edit a migration that has already run somewhere. To change the
 * schema, add a new file (002_..., 003_...).
 */

// This file lives in src/db/ (or dist/db/ after building); both are two
// levels below apps/api/, so this path works in dev and in production.
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

// Any constant number works; it just has to be the same for every runner.
const MIGRATION_LOCK_ID = 727_001;

export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    // An advisory lock makes sure two copies of the app starting at once
    // (common on deploys) don't both try to run the same migration.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text        PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const alreadyApplied = new Set(rows.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort(); // 001_, 002_, ... sort correctly as strings

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

      // Transaction = all-or-nothing. If line 30 of a migration fails, the
      // first 29 lines are rolled back, so we never end up half-migrated.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }

  return applied;
}
