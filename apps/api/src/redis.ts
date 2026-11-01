import { Redis } from 'ioredis';

/**
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

/**
 * A dedicated connection for SUBSCRIBE. Once a connection subscribes it can
 * only listen, so it can't share the general one. Unlike the client above,
 * it keeps the default retry behaviour: if Redis restarts, ioredis
 * reconnects and re-subscribes automatically.
 */
export function createSubscriber(url: string): Redis {
  return new Redis(url);
}
