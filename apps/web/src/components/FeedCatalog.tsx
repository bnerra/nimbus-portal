import { useMemo, useState } from 'react';
import { api, type Feed, type Region } from '../api';
import { useApi } from '../useApi';

const REGION_FILTERS: Array<{ value: Region | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All regions' },
  { value: 'NA', label: 'North America' },
  { value: 'EMEA', label: 'EMEA' },
  { value: 'APAC', label: 'APAC' },
];

const ASSET_CLASS_LABELS: Record<Feed['assetClass'], string> = {
  equities: 'Equities',
  options: 'Options',
  futures: 'Futures',
  fx: 'FX',
};

/** The catalog of market data feeds Nimbus offers, with a region filter. */
export function FeedCatalog() {
  const feeds = useApi(api.getFeeds);
  const [region, setRegion] = useState<Region | 'ALL'>('ALL');

  // Filtering happens in the browser: the catalog is small. For thousands
  // of rows we'd filter on the server instead (a ?region= query parameter).
  const visible = useMemo(
    () => (feeds.data ?? []).filter((f) => region === 'ALL' || f.region === region),
    [feeds.data, region],
  );

  return (
    <section className="card" aria-labelledby="feeds-heading">
      <div className="card-header">
        <h2 id="feeds-heading">Feed catalog</h2>
        <div className="segmented" role="group" aria-label="Filter by region">
          {REGION_FILTERS.map((r) => (
            <button
              key={r.value}
              type="button"
              className="segment"
              aria-pressed={region === r.value}
              onClick={() => setRegion(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {feeds.status === 'error' && (
        <div className="alert" role="alert">
          <span>
            <strong>Couldn't load feeds.</strong> {feeds.error.message}
          </span>
          <button type="button" className="button" onClick={feeds.reload}>
            Try again
          </button>
        </div>
      )}

      {feeds.status === 'loading' && !feeds.data && <p className="meta">Loading feeds…</p>}

      {feeds.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Feed</th>
                <th scope="col">Venue</th>
                <th scope="col">Asset class</th>
                <th scope="col">Region</th>
                <th scope="col" className="num">
                  Subscribers
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((feed) => (
                <tr key={feed.id}>
                  <td>
                    <code className="feed-code">{feed.code}</code>
                  </td>
                  <td>{feed.name}</td>
                  <td>{feed.venue}</td>
                  <td>
                    <span className={`tag tag-${feed.assetClass}`}>
                      {ASSET_CLASS_LABELS[feed.assetClass]}
                    </span>
                  </td>
                  <td>{feed.region}</td>
                  <td className="num">{feed.subscriberCount}</td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No feeds in this region.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
