import type pg from 'pg';

/**
 * Demo data so the app has something to show. Fictional customers; the feed
 * names mirror real exchange data products, since that's what a market data
 * vendor would actually distribute.
 *
 * Safe to run repeatedly: every insert uses ON CONFLICT, so running the seed
 * twice doesn't create duplicates ("idempotent").
 */

const organizations = [
  { slug: 'granite-peak', name: 'Granite Peak Capital' },
  { slug: 'bluewater', name: 'Bluewater Trading' },
];

const feeds = [
  {
    code: 'NYSE-INT',
    name: 'NYSE Integrated',
    venue: 'NYSE',
    assetClass: 'equities',
    region: 'NA',
  },
  {
    code: 'NSDQ-TV',
    name: 'Nasdaq TotalView-ITCH',
    venue: 'Nasdaq',
    assetClass: 'equities',
    region: 'NA',
  },
  {
    code: 'CBOE-OPT',
    name: 'Cboe Options PITCH',
    venue: 'Cboe',
    assetClass: 'options',
    region: 'NA',
  },
  { code: 'CME-MDP', name: 'CME MDP 3.0', venue: 'CME', assetClass: 'futures', region: 'NA' },
  {
    code: 'LSE-MITCH',
    name: 'LSE Millennium ITCH',
    venue: 'LSE',
    assetClass: 'equities',
    region: 'EMEA',
  },
  { code: 'EUREX-EOBI', name: 'Eurex EOBI', venue: 'Eurex', assetClass: 'futures', region: 'EMEA' },
  { code: 'JPX-FLEX', name: 'JPX FLEX Full', venue: 'JPX', assetClass: 'equities', region: 'APAC' },
  {
    code: 'FX-AGG',
    name: 'Nimbus FX Aggregate',
    venue: 'Multi-venue',
    assetClass: 'fx',
    region: 'NA',
  },
];

// Which org subscribes to which feeds, and how it's delivered.
const subscriptions: Record<string, Array<[code: string, delivery: 'direct' | 'consolidated']>> = {
  'granite-peak': [
    ['NYSE-INT', 'direct'],
    ['NSDQ-TV', 'direct'],
    ['CBOE-OPT', 'direct'],
    ['CME-MDP', 'direct'],
    ['FX-AGG', 'consolidated'],
  ],
  bluewater: [
    ['LSE-MITCH', 'direct'],
    ['EUREX-EOBI', 'direct'],
    ['NYSE-INT', 'consolidated'],
  ],
};

export async function seed(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const org of organizations) {
      // $1, $2 are *parameters*. Never build SQL by gluing strings together;
      // parameters keep data separate from SQL, which prevents SQL injection.
      await client.query(
        `INSERT INTO organizations (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
        [org.slug, org.name],
      );
    }

    for (const f of feeds) {
      await client.query(
        `INSERT INTO feeds (code, name, venue, asset_class, region) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name, venue = EXCLUDED.venue,
           asset_class = EXCLUDED.asset_class, region = EXCLUDED.region`,
        [f.code, f.name, f.venue, f.assetClass, f.region],
      );
    }

    for (const [slug, subs] of Object.entries(subscriptions)) {
      for (const [code, delivery] of subs) {
        // Look up both ids by their human-readable keys inside the INSERT.
        await client.query(
          `INSERT INTO subscriptions (organization_id, feed_id, delivery)
           SELECT o.id, f.id, $3 FROM organizations o, feeds f
           WHERE o.slug = $1 AND f.code = $2
           ON CONFLICT (organization_id, feed_id) DO UPDATE SET delivery = EXCLUDED.delivery`,
          [slug, code, delivery],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
