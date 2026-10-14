// CLI entry point: `npm run db:migrate` (from the repo root).
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';

const pool = createPool(config.DATABASE_URL);

try {
  const applied = await runMigrations(pool);
  if (applied.length === 0) {
    console.log('Database is up to date. No migrations to run.');
  } else {
    console.log(`Applied ${applied.length} migration(s):`);
    for (const name of applied) console.log(`  - ${name}`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
