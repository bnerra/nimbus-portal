import { api, type CheckResult } from '../api';
import { useApi } from '../useApi';

/**
 * Shows whether the API, database and Redis are reachable. In Phase 3 this
 * refreshes itself on a timer; in Phase 4 it updates live.
 */
export function SystemHealth() {
  const health = useApi(api.getHealth);

  return (
    <section className="card" aria-labelledby="health-heading">
      <div className="card-header">
        <h2 id="health-heading">System health</h2>
        <button
          type="button"
          className="button"
          onClick={health.reload}
          disabled={health.status === 'loading'}
        >
          {health.status === 'loading' ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {health.status === 'error' ? (
        // If the API itself is unreachable, say so plainly.
        <div className="alert" role="alert">
          <span>
            <StatusDot status="down" />
            <strong>API unreachable.</strong> {health.error.message}
          </span>
        </div>
      ) : health.data ? (
        <>
          <div className="checks">
            <CheckTile label="API" check={{ status: 'up', latencyMs: 0 }} hideLatency />
            <CheckTile label="Database" check={health.data.checks.database} />
            <CheckTile label="Redis" check={health.data.checks.redis} />
          </div>
          <p className="meta">
            Last checked {new Date(health.data.checkedAt).toLocaleTimeString()} · API up{' '}
            {formatDuration(health.data.uptimeSeconds)}
          </p>
        </>
      ) : (
        <p className="meta">Checking services…</p>
      )}
    </section>
  );
}

function CheckTile(props: { label: string; check: CheckResult; hideLatency?: boolean }) {
  const { label, check, hideLatency } = props;
  return (
    <div className={`check check-${check.status}`}>
      <div className="check-label">
        <StatusDot status={check.status} />
        {label}
      </div>
      <div className="check-value">{check.status === 'up' ? 'Operational' : 'Down'}</div>
      {!hideLatency && (
        <div className="check-detail" title={check.error}>
          {check.status === 'up' ? `${check.latencyMs} ms` : (check.error ?? 'Unavailable')}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: 'up' | 'down' }) {
  // The text label next to the dot carries the meaning; color is a bonus,
  // so people with color-vision deficiency aren't left guessing.
  return <span className={`dot dot-${status}`} aria-hidden="true" />;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
