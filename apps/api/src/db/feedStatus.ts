import type pg from 'pg';

/**
 * "What is every feed doing right now?" Used by two callers:
 *   - GET /api/feeds/status         (one answer, on request)
 *   - the live status stream (SSE)  (pushed to every connected browser)
 * Keeping the query in one place means both always agree.
 */

export type FeedRegion = 'NA' | 'EMEA' | 'APAC';

/** One feed's most recent health reading, as sent to the dashboard. */
export type FeedStatus = {
  code: string;
  name: string;
  venue: string;
  region: FeedRegion;
  assetClass: 'equities' | 'options' | 'futures' | 'fx';
  status: 'up' | 'degraded' | 'down' | 'unknown';
  latencyUs: number | null;
  messagesPerSec: number | null;
  gapCount: number | null;
  recordedAt: string | null;
  stale: boolean;
};

export type FeedStatusSnapshot = { checkedAt: string; feeds: FeedStatus[] };

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

export async function fetchFeedStatus(pool: pg.Pool): Promise<FeedStatusSnapshot> {
  const { rows } = await pool.query<FeedStatus>(FEED_STATUS_SQL, [STALE_AFTER_SECONDS]);
  return { checkedAt: new Date().toISOString(), feeds: rows };
}