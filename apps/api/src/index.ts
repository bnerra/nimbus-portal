// Entry point: wires real dependencies into the app and starts the server.
import { createApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db/pool.js';
import { createRedis } from './redis.js';

const pool = createPool(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

redis.on('error', (err) => {
  // ioredis reconnects on its own; just log instead of crashing.
  console.error('Redis error:', err.message);
});

const app = createApp({ pool, redis });

const server = app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});

/**
 * Graceful shutdown. When you press Ctrl+C (SIGINT) or a host stops the
 * container (SIGTERM), finish in-flight requests and close connections
 * cleanly instead of cutting them off mid-query.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);

  // Safety net: if something hangs, exit anyway after 10s.
  setTimeout(() => process.exit(1), 10_000).unref();

  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
