import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricPoint } from '../api';
import { formatLatency } from '../format';
import { useFeedMetrics } from '../queries';

const RANGES = [5, 15, 60] as const;
type Range = (typeof RANGES)[number];

// Recharts draws SVG, and SVG attributes like fill="..." can't read CSS
// variables, so these mirror the tokens in styles.css.
const COLORS = {
  line: '#4da3ff', // --accent
  grid: '#22314d', // --border
  axis: '#8fa1bd', // --text-muted
  degraded: '#fbbf24', // --degraded
  down: '#f87171', // --down
};

/** A point as the chart needs it: time as a number so the x-axis is to scale. */
type ChartPoint = MetricPoint & { time: number };

/** A stretch of consecutive non-"up" buckets, shaded behind the line. */
type Incident = { from: number; to: number; status: 'degraded' | 'down' };

/** Latency over time for the feed selected in the status grid. */
export function FeedLatencyChart({ code }: { code: string | null }) {
  const [minutes, setMinutes] = useState<Range>(15);
  const metrics = useFeedMetrics(code, minutes);

  // ---- 1. Prepare the data ----
  const data = metrics.data;
  const points: ChartPoint[] = (data?.points ?? []).map((p) => ({
    ...p,
    time: new Date(p.t).getTime(),
  }));
  const incidents = data ? findIncidents(points, data.bucketSeconds) : [];
  const ticks = minuteTicks(points, minutes);

  // ---- 2. Describe the chart ----
  return (
    <section className="card" aria-labelledby="latency-heading">
      <div className="card-header">
        <h2 id="latency-heading">
          Latency{data ? ` · ${data.feed.code}` : ''}
          {data && <span className="heading-sub"> {data.feed.name}</span>}
        </h2>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className="segment"
              aria-pressed={minutes === r}
              onClick={() => setMinutes(r)}
            >
              {r} min
            </button>
          ))}
        </div>
      </div>

      {code === null && <p className="meta">Select a feed above to see its latency history.</p>}

      {metrics.isError && (
        <div className="alert" role="alert">
          <span>
            <strong>Couldn't load history.</strong> {metrics.error.message}
          </span>
        </div>
      )}

      {code !== null && metrics.isPending && <p className="meta">Loading history…</p>}

      {data && points.length === 0 && (
        <p className="meta">No readings in this window yet. Is the simulator running?</p>
      )}

      {data && points.length > 0 && (
        // Dim the old chart while a different feed/range loads.
        <div className="chart" data-loading={metrics.isPlaceholderData}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />

              {/* Incidents first, so the line draws on top of the shading. */}
              {incidents.map((i) => (
                <ReferenceArea
                  key={i.from}
                  x1={i.from}
                  x2={i.to}
                  fill={COLORS[i.status]}
                  fillOpacity={0.14}
                  ifOverflow="hidden"
                />
              ))}

              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                ticks={ticks}
                tickFormatter={formatClock}
                stroke={COLORS.axis}
                tick={{ fontSize: 12 }}
              />
              <YAxis
                domain={[0, 'auto']}
                tickFormatter={formatLatency}
                stroke={COLORS.axis}
                tick={{ fontSize: 12 }}
                width={64}
              />
              <Tooltip
                content={({ active, payload }) => (
                  <ChartTooltip
                    active={active}
                    point={payload?.[0]?.payload as ChartPoint | undefined}
                  />
                )}
                cursor={{ stroke: COLORS.axis, strokeWidth: 1 }}
              />
              <Line
                dataKey="avgLatencyUs"
                type="linear"
                stroke={COLORS.line}
                strokeWidth={2}
                dot={false}
                // A down feed has no latency (null). Leave a visible gap
                // instead of drawing a line across the outage.
                connectNulls={false}
                // Re-animating on every 5-second poll would be distracting.
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>

          <p className="meta">
            Average per {data.bucketSeconds}s · shaded areas are incidents (
            <span className="legend-swatch legend-degraded" aria-hidden="true" /> degraded,{' '}
            <span className="legend-swatch legend-down" aria-hidden="true" /> down) ·{' '}
            {summarise(points, incidents.length)}
          </p>
        </div>
      )}
    </section>
  );
}

function ChartTooltip({ active, point }: { active?: boolean; point?: ChartPoint }) {
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-time">{new Date(point.time).toLocaleTimeString()}</div>
      <div>
        <strong>{formatLatency(point.avgLatencyUs)}</strong> avg
        {point.maxLatencyUs !== null && ` · ${formatLatency(point.maxLatencyUs)} max`}
      </div>
      <div>
        {point.messagesPerSec.toLocaleString()} msg/s · {point.gapCount} gaps
      </div>
      {point.status !== 'up' && (
        <div className={`chart-tooltip-status status-${point.status}`}>
          {point.status === 'down' ? 'Down' : 'Degraded'}
        </div>
      )}
    </div>
  );
}

/**
 * Turn buckets into incident stretches: consecutive buckets with the same
 * non-"up" status become one shaded area from the first bucket's start to
 * the last bucket's end.
 */
function findIncidents(points: ChartPoint[], bucketSeconds: number): Incident[] {
  const incidents: Incident[] = [];
  for (const p of points) {
    if (p.status === 'up') continue;
    const end = p.time + bucketSeconds * 1000;
    const last = incidents.at(-1);
    if (last && last.status === p.status && last.to === p.time) {
      last.to = end; // continues the current stretch
    } else {
      incidents.push({ from: p.time, to: end, status: p.status });
    }
  }
  return incidents;
}

/** A one-line text summary: the chart's main point, readable without seeing it. */
function summarise(points: ChartPoint[], incidentCount: number): string {
  const latencies = points.map((p) => p.avgLatencyUs).filter((v): v is number => v !== null);
  if (latencies.length === 0) return 'no latency readings';
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const incidents = incidentCount === 1 ? '1 incident' : `${incidentCount} incidents`;
  return `overall average ${formatLatency(avg)}, ${incidents}`;
}

/**
 * Tick marks on round clock times (every 1, 3 or 10 minutes depending on the
 * range), so labels never repeat the same "8:52 PM".
 */
function minuteTicks(points: ChartPoint[], minutes: Range): number[] {
  if (points.length === 0) return [];
  const step = { 5: 1, 15: 3, 60: 10 }[minutes] * 60_000;
  const first = points[0]!.time;
  const last = points.at(-1)!.time;
  const ticks: number[] = [];
  for (let t = Math.ceil(first / step) * step; t <= last; t += step) ticks.push(t);
  return ticks;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
