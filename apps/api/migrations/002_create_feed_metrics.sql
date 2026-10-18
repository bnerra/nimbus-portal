-- 002: Time-series health metrics for each feed.
--
-- The simulator writes one row per feed per tick (about once a second).
-- The dashboard reads "latest status per feed" and "the last N minutes
-- for one feed" (for charts). Both reads use the index at the bottom.

CREATE TABLE feed_metrics (
    -- bigint identity instead of uuid: this table only ever grows, very
    -- fast, and nothing outside the database needs to reference a row.
    -- A sequential 8-byte number is smaller and faster to index.
    id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    feed_id           uuid        NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
    recorded_at       timestamptz NOT NULL DEFAULT now(),

    status            text        NOT NULL
                      CHECK (status IN ('up', 'degraded', 'down')),

    -- Latency in MICROseconds, stored as a whole number (no float rounding).
    -- NULL when the feed is down: there's no latency to measure.
    latency_us        integer     CHECK (latency_us >= 0),

    messages_per_sec  integer     NOT NULL CHECK (messages_per_sec >= 0),

    -- The last sequence number the feed delivered. Real market data feeds
    -- number every message so receivers can detect gaps.
    sequence_number   bigint      NOT NULL CHECK (sequence_number >= 0),

    -- How many messages were missed during this tick (0 = healthy).
    gap_count         integer     NOT NULL DEFAULT 0 CHECK (gap_count >= 0),

    -- A down feed can't report a latency; an up/degraded one must.
    -- Named so the error message says what rule was broken.
    CONSTRAINT feed_metrics_latency_matches_status
        CHECK ((status = 'down') = (latency_us IS NULL))
);

-- Composite index, feed first, newest first:
--   * "latest row for feed X"            → jump to feed X, take the first entry
--   * "feed X over the last 15 minutes"  → jump to feed X, read until too old
-- Leftmost-column rule: this helps any query that filters by feed_id.
CREATE INDEX feed_metrics_feed_recorded_idx ON feed_metrics (feed_id, recorded_at DESC);