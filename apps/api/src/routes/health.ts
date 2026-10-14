import { Router } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';

type CheckResult = { status: 'up' | 'down'; latencyMs: number; error?: string };

/** Run a check, time it, and never let it hang longer than `timeoutMs`. */
async function timedCheck(fn: () => Promise<unknown>, timeoutMs = 2_000): Promise<CheckResult> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - start),
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/health
 *
 * Reports whether the API can reach its dependencies. Hosting platforms and
 * load balancers call an endpoint like this to decide if an instance is
 * healthy, so it returns 503 (not 200) when something is down.
 */
export function healthRouter(deps: { pool: pg.Pool; redis: Redis }): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    // Run both checks at the same time rather than one after the other.
    const [database, redis] = await Promise.all([
      timedCheck(() => deps.pool.query('SELECT 1')),
      timedCheck(async () => {
        // Report the connection state in plain words rather than surfacing
        // ioredis's internal error text.
        if (deps.redis.status !== 'ready') {
          throw new Error(`Not connected (${deps.redis.status})`);
        }
        return deps.redis.ping();
      }),
    ]);

    const healthy = database.status === 'up' && redis.status === 'up';

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database, redis },
    });
  });

  return router;
}
