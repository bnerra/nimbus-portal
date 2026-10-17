import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { createRedis } from '../src/redis.js';
import type { Feed } from '../src/routes/feeds.js';

interface FeedsResponse {
  feeds: Feed[];
}

const pool = createPool(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
// supertest calls the app in-process: no port, no running server needed.
const app = createApp({ pool, redis });

// The Redis client connects in the background. Wait until it's ready, or the
// first health check could honestly (but unhelpfully) report Redis as down.
beforeAll(async () => {
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve) => redis.once('ready', () => resolve()));
  }
});

afterAll(async () => {
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
