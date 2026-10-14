import { Redis } from 'ioredis';

/**
 * Redis isn't used for real work until Phase 4 (pub/sub for live updates).
 * We connect now so the health check can prove the whole stack is wired up.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    // By default ioredis queues commands while disconnected and retries them
    // forever. For a health check we'd rather get a fast, honest "down".
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
}
