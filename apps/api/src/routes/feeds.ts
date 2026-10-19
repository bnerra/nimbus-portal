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

/** One feed's most recent health reading, as sent to the dashboard. */
export type FeedStatus = {
  code: string;
  name: string;
  venue: string;
  region: 'NA' | 'EMEA' | 'APAC';
  assetClass: Feed['assetClass'];
  status: 'up' | 'degraded' | 'down' | 'unknown';
  latencyUs: number | null;
  messagesPerSec: number | null;
  gapCount: number | null;
  recordedAt: string | null;
  stale: boolean;
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

// The simulator writes every second. If a feed's newest reading is older than
// this, something upstream has stopped (e.g. the simulator isn't running) and
// the dashboard should say so instead of showing old numbers as current.
const STALE_AFTER_SECONDS = 10;

// LEFT JOIN LATERAL runs the inner query once PER FEED: "this feed's newest
// metric row". With the (feed_id, recorded_at DESC) index each lookup is a
// single index probe, and LEFT keeps feeds that have no metrics yet.
const FEED_STATUS_SQL = `
  SELECT f.code, f.name, f.venue, f.region,
         f.asset_class                  AS "assetClass",
         COALESCE(m.status, 'unknown')  AS status,
         m.latency_us                   AS "latencyUs",
         m.messages_per_sec             AS "messagesPerSec",
         m.gap_count                    AS "gapCount",
         m.recorded_at                  AS "recordedAt",
         (m.recorded_at IS NULL
           OR m.recorded_at < now() - make_interval(secs => $1)) AS stale
  FROM feeds f
  LEFT JOIN LATERAL (
    SELECT status, latency_us, messages_per_sec, gap_count, recorded_at
    FROM feed_metrics
    WHERE feed_id = f.id
    ORDER BY recorded_at DESC
    LIMIT 1
  ) m ON true
  ORDER BY array_position(ARRAY['NA', 'EMEA', 'APAC'], f.region), f.venue, f.name
`;

// Feed codes look like NYSE-INT or EUREX-EOBI. Validating input at the edge
// means bad requests get a clear 400 instead of reaching the database.
const feedCodeSchema = z.string().regex(/^[A-Z0-9-]{2,20}$/, 'Invalid feed code');

const REGIONS = ['NA', 'EMEA', 'APAC'];
const regionSchema = z.enum(REGIONS);
const optionalRegionSchema = z.preprocess((val) => {
  if (typeof val !== 'string') return val;

  const cleaned = val.trim().toUpperCase();

  return cleaned === '' ? undefined : cleaned;
}, regionSchema.optional());

/**
 * Feed catalog: the products Nimbus sells. This is public, non-tenant data,
 * so no login is needed yet. Org-specific data (my subscriptions, my alerts)
 * comes in Phase 5, once we know *who* is asking.
 */
export function feedsRouter(deps: { pool: pg.Pool }): Router {
  const router = Router();

  // GET /api/feeds
  router.get('/', async (req, res) => {
    const parsed = optionalRegionSchema.safeParse(req.query.region);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_region', `Valid regions are: ${REGIONS.join(', ')}`);
    }

    // array_position gives a custom sort order (NA, EMEA, APAC) instead of
    // alphabetical (APAC, EMEA, NA).
    const { rows } = await deps.pool.query<Feed>(
      `${FEED_SELECT}
        WHERE ($1::text IS NULL OR f.region = $1)
        GROUP BY f.id
        ORDER BY array_position($2::text[], f.region), f.venue, f.name`,
      [parsed.data ?? null, REGIONS],
    );

    res.json({ feeds: rows });
  });

  // GET /api/feeds/status
  // Must be registered BEFORE '/:code', or Express would treat "status" as a feed code.
  router.get('/status', async (_req, res) => {
    const { rows } = await deps.pool.query<FeedStatus>(FEED_STATUS_SQL, [STALE_AFTER_SECONDS]);
    res.json({ checkedAt: new Date().toISOString(), feeds: rows });
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
