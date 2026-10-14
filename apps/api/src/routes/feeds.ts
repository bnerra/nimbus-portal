import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError } from '../errors.js';

/**
 * The shape the API sends to clients. Note it's camelCase (JavaScript style)
 * even though the database columns are snake_case (SQL style). The SQL below
 * renames columns with AS "camelCase" so no extra mapping code is needed.
 */
export type Feed = {
  id: string;
  code: string;
  name: string;
  venue: string;
  assetClass: 'equities' | 'options' | 'futures' | 'fx';
  region: 'NA' | 'EMEA' | 'APAC';
  subscriberCount: number;
};

// LEFT JOIN keeps feeds with zero subscribers (an inner JOIN would drop them).
// COUNT(...)::int because Postgres returns COUNT as bigint, which node-pg
// hands back as a *string* to avoid losing precision.
const FEED_SELECT = `
  SELECT f.id, f.code, f.name, f.venue,
         f.asset_class AS "assetClass",
         f.region,
         COUNT(s.organization_id)::int AS "subscriberCount"
  FROM feeds f
  LEFT JOIN subscriptions s ON s.feed_id = f.id
`;

// Feed codes look like NYSE-INT or EUREX-EOBI. Validating input at the edge
// means bad requests get a clear 400 instead of reaching the database.
const feedCodeSchema = z.string().regex(/^[A-Z0-9-]{2,20}$/, 'Invalid feed code');

/**
 * Feed catalog: the products Nimbus sells. This is public, non-tenant data,
 * so no login is needed yet. Org-specific data (my subscriptions, my alerts)
 * comes in Phase 5, once we know *who* is asking.
 */
export function feedsRouter(deps: { pool: pg.Pool }): Router {
  const router = Router();

  // GET /api/feeds
  router.get('/', async (_req, res) => {
    // array_position gives a custom sort order (NA, EMEA, APAC) instead of
    // alphabetical (APAC, EMEA, NA).
    const { rows } = await deps.pool.query<Feed>(
      `${FEED_SELECT}
       GROUP BY f.id
       ORDER BY array_position(ARRAY['NA', 'EMEA', 'APAC'], f.region), f.venue, f.name`,
    );
    res.json({ feeds: rows });
  });

  // GET /api/feeds/:code
  router.get('/:code', async (req, res) => {
    const parsed = feedCodeSchema.safeParse(req.params.code.toUpperCase());
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_feed_code', 'Feed codes use letters, numbers and dashes');
    }

    const { rows } = await deps.pool.query<Feed>(`${FEED_SELECT} WHERE f.code = $1 GROUP BY f.id`, [
      parsed.data,
    ]);

    const feed = rows[0];
    if (!feed) throw new HttpError(404, 'feed_not_found', `Feed ${parsed.data} not found`);

    res.json({ feed });
  });

  return router;
}
