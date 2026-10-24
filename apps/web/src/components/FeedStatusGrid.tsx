import type { FeedHealth, FeedStatus } from '../api';
import { formatLatency, formatRate } from '../format';
import { useFeedStatus } from '../queries';

const STATUS_LABELS: Record<FeedHealth, string> = {
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'No data',
};

type Props = {
  selectedCode: string | null;
  onSelect: (code: string) => void;
};

/**
 * One tile per feed showing its latest reading. Polls every 3 seconds
 * (see useFeedStatus), so tiles change as the simulator injects incidents.
 * Clicking a tile selects that feed for the latency chart.
 */
export function FeedStatusGrid({ selectedCode, onSelect }: Props) {
  const status = useFeedStatus();
  const feeds = status.data?.feeds ?? [];

  // If EVERY feed is stale, the problem is upstream (the monitoring pipeline
  // stopped), not eight simultaneous outages. Say that once, plainly.
  const allStale = feeds.length > 0 && feeds.every((f) => f.stale);

  return (
    <section className="card" aria-labelledby="status-heading">
      <div className="card-header">
        <h2 id="status-heading">Live feed status</h2>
        {feeds.length > 0 && <StatusSummary feeds={feeds} />}
      </div>

      {status.isError && (
        <div className="alert" role="alert">
          <span>
            <strong>Live status unavailable.</strong>
            {status.data ? ' Showing the last values we received.' : ` ${status.error.message}`}
          </span>
        </div>
      )}

      {allStale && !status.isError && (
        <div className="alert alert-warning" role="status">
          <span>
            <strong>No new readings.</strong> Monitoring data has stopped arriving; values below may
            be out of date.
          </span>
        </div>
      )}

      {status.isPending && <p className="meta">Loading feed status…</p>}

      {status.data && (
        <>
          <ul className="status-grid">
            {feeds.map((feed) => (
              <StatusTile
                key={feed.code}
                feed={feed}
                selected={feed.code === selectedCode}
                onSelect={onSelect}
              />
            ))}
          </ul>
          <p className="meta">
            Updated {new Date(status.data.checkedAt).toLocaleTimeString()} · refreshes every 3s
          </p>
        </>
      )}
    </section>
  );
}

function StatusTile(props: {
  feed: FeedStatus;
  selected: boolean;
  onSelect: (code: string) => void;
}) {
  const { feed, selected, onSelect } = props;
  return (
    // data-* attributes let the CSS style by status and staleness without
    // building class-name strings by hand.
    <li
      className="status-tile"
      data-status={feed.status}
      data-stale={feed.stale}
      data-selected={selected}
    >
      <div className="status-tile-top">
        {/* The real button is just the feed code; CSS stretches its click
            area over the whole tile (see .tile-select::after). A <button>
            can't legally contain the <dl> below, so this keeps valid HTML
            while the whole tile is still clickable and keyboard-focusable. */}
        <button
          type="button"
          className="tile-select feed-code"
          aria-pressed={selected}
          aria-label={`Show latency for ${feed.code}, ${feed.name}`}
          onClick={() => onSelect(feed.code)}
        >
          {feed.code}
        </button>
        <span className="status-label">
          <span className={`dot dot-${feed.status}`} aria-hidden="true" />
          {STATUS_LABELS[feed.status]}
        </span>
      </div>
      <div className="status-tile-name">{feed.name}</div>

      <dl className="status-metrics">
        <div>
          <dt>Latency</dt>
          <dd>{formatLatency(feed.latencyUs)}</dd>
        </div>
        <div>
          <dt>Msg/s</dt>
          <dd>{formatRate(feed.messagesPerSec)}</dd>
        </div>
        <div>
          <dt>Gaps</dt>
          <dd>{feed.gapCount ?? '—'}</dd>
        </div>
      </dl>

      {feed.stale && feed.recordedAt && (
        <div className="status-stale">
          Stale · last reading {new Date(feed.recordedAt).toLocaleTimeString()}
        </div>
      )}
    </li>
  );
}

/**
 * "6 up · 1 degraded · 1 down": the at-a-glance answer to "is anything wrong?"
 * A stale feed is counted as "stale", not by its last status: we don't
 * actually know it's still up, so the summary shouldn't claim it is.
 */
function StatusSummary({ feeds }: { feeds: FeedStatus[] }) {
  type Bucket = FeedHealth | 'stale';
  const counts: Record<Bucket, number> = { down: 0, degraded: 0, up: 0, unknown: 0, stale: 0 };
  for (const feed of feeds) counts[feed.stale && feed.recordedAt ? 'stale' : feed.status] += 1;

  const labels: Record<Bucket, string> = { ...STATUS_LABELS, stale: 'Stale' };
  const order: Bucket[] = ['down', 'degraded', 'up', 'stale', 'unknown'];

  return (
    <div className="status-summary">
      {order
        .filter((b) => counts[b] > 0)
        .map((b) => (
          <span key={b} className="status-label">
            <span className={`dot dot-${b === 'stale' ? 'unknown' : b}`} aria-hidden="true" />
            {counts[b]} {labels[b].toLowerCase()}
          </span>
        ))}
    </div>
  );
}
