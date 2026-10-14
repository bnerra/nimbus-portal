import pg from 'pg';

/**
 * A connection *pool* keeps a handful of open Postgres connections and lends
 * them out per query. Opening a fresh connection for every request is slow
 * (a network handshake + auth each time), so every real Node app uses a pool.
 */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10, // at most 10 simultaneous connections from this process
    idleTimeoutMillis: 30_000, // close connections that sit unused for 30s
    connectionTimeoutMillis: 5_000, // give up if Postgres doesn't answer in 5s
  });

  // An idle connection can error (e.g. Postgres restarts). Without this
  // listener Node treats it as an unhandled error and crashes the process.
  pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client', err);
  });

  return pool;
}
