// CLI entry point: `npm run db:seed` (from the repo root).
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { seed } from '../db/seed.js';

const pool = createPool(config.DATABASE_URL);

try {
  await seed(pool);
  console.log('Seed data loaded.');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
