import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';

/**
 * These are *integration* tests: they talk to the real Postgres and Redis
 * from docker-compose, so they catch problems mocks would hide (bad SQL,
 * wrong column names, missing migrations).
 *
 * For now they use the dev database. Because migrations and the seed are
 * idempotent, that's safe. Phase 7 moves tests to their own database.
 */
export default async function setup() {
  const pool = createPool(config.DATABASE_URL);
  try {
    await runMigrations(pool);
    await seed(pool);
  } finally {
    await pool.end();
  }
}
