import express, { type Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { errorHandler, notFoundHandler } from './errors.js';
import { feedsRouter } from './routes/feeds.js';
import { healthRouter } from './routes/health.js';

export type AppDeps = {
  pool: pg.Pool;
  redis: Redis;
};

/**
 * Builds the Express app but does NOT start listening on a port.
 *
 * Passing dependencies in ("dependency injection") instead of importing them
 * globally means tests can hand in their own database/Redis connections and
 * call the app directly, without starting a real server.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by'); // don't advertise "Express" to attackers
  app.use(express.json({ limit: '100kb' }));

  // All API routes live under /api. The web app's dev server forwards /api
  // requests here (see apps/web/vite.config.ts), so the browser sees one
  // origin and we don't need CORS.
  app.use('/api/health', healthRouter(deps));
  app.use('/api/feeds', feedsRouter(deps));

  // These must come last: they only run if nothing above handled the request.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
