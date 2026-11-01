import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { STATUS_CHANNEL, StatusBroadcaster } from '../src/realtime/statusBroadcaster.js';
import { createRedis, createSubscriber } from '../src/redis.js';
import type { Feed } from '../src/routes/feeds.js';

interface FeedsResponse {
  feeds: Feed[];
}

const pool = createPool(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
const broadcaster = new StatusBroadcaster(pool, createSubscriber(config.REDIS_URL));
// supertest calls the app in-process: no port, no running server needed.
const app = createApp({ pool, redis, broadcaster });

// The Redis client connects in the background. Wait until it's ready, or the
// first health check could honestly (but unhelpfully) report Redis as down.
beforeAll(async () => {
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve) => redis.once('ready', () => resolve()));
    await broadcaster.start();
  }
});

afterAll(async () => {
  await broadcaster.close();
  await pool.end();
  await redis.quit();
});

describe('GET /api/health', () => {
  it('reports the database and Redis as up', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('up');
    expect(res.body.checks.redis.status).toBe('up');
  });
});

describe('GET /api/feeds', () => {
  it('returns the seeded feed catalog in camelCase', async () => {
    const res = await request(app).get('/api/feeds');

    expect(res.status).toBe(200);
    expect(res.body.feeds.length).toBeGreaterThanOrEqual(8);

    const nyse = res.body.feeds.find((f: { code: string }) => f.code === 'NYSE-INT');
    expect(nyse).toMatchObject({
      name: 'NYSE Integrated',
      assetClass: 'equities',
      region: 'NA',
      subscriberCount: 2, // both seeded orgs subscribe to it
    });
  });
});

describe('GET /api/feeds/:code', () => {
  it('returns a single feed (case-insensitive code)', async () => {
    const res = await request(app).get('/api/feeds/cme-mdp');

    expect(res.status).toBe(200);
    expect(res.body.feed.code).toBe('CME-MDP');
  });

  it('returns 404 with the standard error shape for an unknown feed', async () => {
    const res = await request(app).get('/api/feeds/NOPE-123');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'feed_not_found', message: 'Feed NOPE-123 not found' },
    });
  });

  it('returns 400 for a malformed code', async () => {
    const res = await request(app).get('/api/feeds/bad!code');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_feed_code');
  });
});

describe('GET /api/feeds?region=...', () => {
  it.each(['EMEA', 'emea', 'Emea', '%20emea%20'])(
    'returns only EMEA feeds for ?region=%s',
    async (region) => {
      const res = await request(app).get(`/api/feeds?region=${region}`);
      const body = res.body as FeedsResponse;

      expect(res.status).toBe(200);
      expect(body.feeds).toHaveLength(2);

      body.feeds.forEach((feed) => {
        expect(feed.region).toBe('EMEA');
      });
    },
  );

  it.each(['MARS', 'NA&region=EMEA'])('returns 400 for ?region=%s', async (region) => {
    const res = await request(app).get(`/api/feeds?region=${region}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'invalid_region', message: 'Valid regions are: NA, EMEA, APAC' },
    });
  });

  it.each(['', '%20%20'])('treats ?region=%s as no filter', async (region) => {
    const filtered = await request(app).get(`/api/feeds?region=${region}`);
    const unfiltered = await request(app).get('/api/feeds');

    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual(unfiltered.body);
  });
});

describe('unknown routes', () => {
  it('return a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('GET /api/feeds/status', () => {
  it('returns one status entry per feed with the expected shape', async () => {
    const res = await request(app).get('/api/feeds/status');

    expect(res.status).toBe(200);
    expect(res.body.feeds).toHaveLength(8);
    for (const feed of res.body.feeds) {
      expect(['up', 'degraded', 'down', 'unknown']).toContain(feed.status);
      expect(typeof feed.stale).toBe('boolean');
    }
  });

  it("reports each feed's newest metric row", async () => {
    // Insert a reading dated slightly in the future so it is guaranteed to be
    // the newest row, even if the simulator is running while tests run.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO feed_metrics
         (feed_id, recorded_at, status, latency_us, messages_per_sec, sequence_number, gap_count)
       SELECT id, now() + interval '1 minute', 'degraded', 4321, 1234, 1, 7
       FROM feeds WHERE code = 'NYSE-INT'
       RETURNING id`,
    );

    try {
      const res = await request(app).get('/api/feeds/status');
      const nyse = res.body.feeds.find((f: { code: string }) => f.code === 'NYSE-INT');

      expect(nyse).toMatchObject({
        status: 'degraded',
        latencyUs: 4321,
        messagesPerSec: 1234,
        gapCount: 7,
        stale: false,
      });
    } finally {
      // Clean up even if an assertion fails, so the fake row can't leak into other tests.
      await pool.query('DELETE FROM feed_metrics WHERE id = $1', [rows[0]?.id]);
    }
  });

  it('is not mistaken for a feed code', async () => {
    // Regression guard for route order: '/status' must be matched before '/:code'.
    const res = await request(app).get('/api/feeds/status');
    expect(res.body.feed).toBeUndefined();
    expect(res.body.feeds).toBeDefined();
  });
});

describe('GET /api/feeds/:code/metrics', () => {
  it('returns bucketed history for a feed', async () => {
    const res = await request(app).get('/api/feeds/cme-mdp/metrics?minutes=15');

    expect(res.status).toBe(200);
    expect(res.body.feed.code).toBe('CME-MDP');
    expect(res.body.minutes).toBe(15);
    expect(res.body.bucketSeconds).toBe(5); // 15 min * 60 / 180 points
    expect(Array.isArray(res.body.points)).toBe(true);
  });

  it('summarises each bucket: averages, max, and the worst status', async () => {
    // Two readings in the same 5-second bucket, safely in the future so the
    // running simulator can't add rows to that bucket.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO feed_metrics
         (feed_id, recorded_at, status, latency_us, messages_per_sec, sequence_number, gap_count)
       SELECT f.id, v.at, v.status, v.latency, v.rate, 1, v.gaps
       FROM feeds f,
            (VALUES (date_trunc('minute', now()) + interval '2 minutes',          'up',       100, 1000, 0),
                    (date_trunc('minute', now()) + interval '2 minutes 1 second', 'degraded', 300, 3000, 4)
            ) AS v(at, status, latency, rate, gaps)
       WHERE f.code = 'JPX-FLEX'
       RETURNING id`,
    );

    try {
      const res = await request(app).get('/api/feeds/JPX-FLEX/metrics?minutes=15');
      const last = res.body.points.at(-1);

      expect(last).toMatchObject({
        status: 'degraded', // worst of up + degraded
        avgLatencyUs: 200,
        maxLatencyUs: 300,
        messagesPerSec: 2000,
        gapCount: 4,
      });
    } finally {
      await pool.query('DELETE FROM feed_metrics WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    }
  });

  it('returns 404 for an unknown feed', async () => {
    const res = await request(app).get('/api/feeds/NOPE-123/metrics');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('feed_not_found');
  });

  it('returns 400 for an out-of-range minutes value', async () => {
    const res = await request(app).get('/api/feeds/CME-MDP/metrics?minutes=999');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_minutes');
  });
});

describe('GET /api/feeds/status/stream (Server-Sent Events)', () => {
  // supertest waits for a response to END, and a live stream never ends.
  // So these tests start a real server on a random free port and read the
  // stream with fetch, one chunk at a time.
  async function openStream() {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    const res = await fetch(`http://localhost:${port}/api/feeds/status/stream`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /** Resolve with the next complete "status" event's data. */
    async function nextStatus(): Promise<{ feeds: unknown[] }> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (block.includes('event: status') && data) return JSON.parse(data.slice(6));
          continue; // e.g. the "retry:" block
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    }

    async function close() {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    return { res, nextStatus, close };
  }

  it('sends an event-stream with the current status straight away', async () => {
    const stream = await openStream();
    try {
      expect(stream.res.status).toBe(200);
      expect(stream.res.headers.get('content-type')).toBe('text/event-stream');

      const first = await stream.nextStatus();
      expect(first.feeds).toHaveLength(8);
    } finally {
      await stream.close();
    }
  });

  it('pushes a fresh snapshot when a tick is announced on Redis', async () => {
    const stream = await openStream();
    try {
      await stream.nextStatus(); // the initial snapshot

      // Pretend to be the simulator: announce a tick on the channel.
      await redis.publish(STATUS_CHANNEL, JSON.stringify({ tick: 1 }));

      const pushed = await stream.nextStatus();
      expect(pushed.feeds).toHaveLength(8);
    } finally {
      await stream.close();
    }
  });

  it('forgets clients that disconnect', async () => {
    const stream = await openStream();
    await stream.nextStatus();
    expect(broadcaster.clientCount).toBe(1);

    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50)); // let 'close' fire
    expect(broadcaster.clientCount).toBe(0);
  });
});
