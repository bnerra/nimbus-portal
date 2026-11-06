import { useEffect, useRef, useState } from 'react';
import type { FeedHealth, FeedStatus } from '../api';
import { formatLatency, formatRate } from '../format';
import { useFeedStatus } from '../queries';
import { type LiveState } from '../useLiveFeedStatus';

const STATUS_LABELS: Record<FeedHealth, string> = {
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'No data',
};

/** How the data is arriving, shown under the tiles. */
const FOOTER_TEXT: Record<LiveState, string> = {
  live: 'pushed live by the server',
  slow: 'live ticks paused; the server refreshes every 5s',
  connecting: 'connecting…',
  reconnecting: 'polling every 3s',
};

type Props = {
  liveState: LiveState;
  selectedCode: string | null;
  onSelect: (code: string) => void;
};

/**
 * One tile per feed showing its latest reading. Updates are pushed live with polling as the fallback,
 * so tiles change as the simulator injects incidents.
 * Clicking a tile selects that feed for the latency chart.
 */
export function FeedStatusGrid({ liveState, selectedCode, onSelect }: Props) {
  // 'slow' still means connected: the stream delivers data, so don't poll.
  const status = useFeedStatus({ live: liveState === 'live' || liveState === 'slow' });
  const feeds = status.data?.feeds ?? [];

  // If EVERY feed is stale, the problem is upstream (the monitoring pipeline
  // stopped), not eight simultaneous outages. Say that once, plainly.
  const allStale = feeds.length > 0 && feeds.every((f) => f.stale);

    // A sentence for screen readers when a feed's status changes.
  const announcement = useStatusAnnouncement(status.data?.feeds);

  return (
    <section className="card" aria-labelledby="status-heading">
      <div className="card-header">
        <h2 id="status-heading">
          Live feed status <LiveBadge state={liveState} />
        </h2>
        {feeds.length > 0 && <StatusSummary feeds={feeds} />}
      </div>
      {/* Invisible on screen, but read aloud by screen readers whenever its
          text changes. It must ALWAYS be rendered (even when empty): screen
          readers only watch live regions that already existed. */}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
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
            Updated {new Date(status.data.checkedAt).toLocaleTimeString()} ·{' '}
            {FOOTER_TEXT[liveState]}
          </p>
        </>
      )}
    </section>
  );
}

/** "Live" when updates are being pushed; otherwise says what's happening. */
function LiveBadge({ state }: { state: LiveState }) {
  const label = {
    live: 'Live',
    slow: 'Live · ticks paused',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
  }[state];
  return (
    <span className="live-badge" data-state={state}>
      <span className="live-dot" aria-hidden="true" />
      {label}
    </span>
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

/**
 * Compares each new snapshot with the previous one and returns a sentence
 * describing what changed, e.g. "At 8:52:03 PM: EUREX-EOBI is down." Stays
 * the same when nothing changed, so screen readers aren't told about every
 * one-second update, only about the moments that matter.
 */
function useStatusAnnouncement(feeds: FeedStatus[] | undefined): string {
  // Last snapshot's status per feed code. A ref: remembering it shouldn't
  // cause a re-render by itself.
  const previous = useRef<Map<string, FeedHealth> | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!feeds) return;
    const current = new Map(feeds.map((f) => [f.code, f.status]));
    const before = previous.current;
    previous.current = current;

    // The very first data isn't a "change"; don't read out all 8 feeds.
    if (!before) return;

    const changes = feeds
      .filter((f) => before.has(f.code) && before.get(f.code) !== f.status)
      .map((f) => `${f.code} is ${STATUS_LABELS[f.status].toLowerCase()}`);

    if (changes.length > 0) {
      // The time makes each message unique: screen readers skip a live region
      // update whose text is identical to the last one.
      setAnnouncement(`At ${new Date().toLocaleTimeString()}: ${changes.join(', ')}.`);
    }
  }, [feeds]);

  return announcement;
}
