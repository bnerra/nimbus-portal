/**
 * Everything that talks to the API lives here, so components never call
 * fetch() directly. One place to handle errors, add auth headers later
 * (Phase 5), or swap in a different base URL for production.
 */

// --- Response types --------------------------------------------------------
// These mirror the API's responses. They're duplicated by hand for now; a
// later phase can move them into a shared package used by both apps.

export type CheckResult = { status: 'up' | 'down'; latencyMs: number; error?: string };

export type Health = {
  status: 'ok' | 'degraded';
  checkedAt: string;
  uptimeSeconds: number;
  checks: { database: CheckResult; redis: CheckResult };
};

export type Region = 'NA' | 'EMEA' | 'APAC';

export type Feed = {
  id: string;
  code: string;
  name: string;
  venue: string;
  assetClass: 'equities' | 'options' | 'futures' | 'fx';
  region: Region;
  subscriberCount: number;
};

/** A feed's live condition. 'unknown' = no readings recorded yet. */
export type FeedHealth = 'up' | 'degraded' | 'down' | 'unknown';

export type FeedStatus = {
  code: string;
  name: string;
  venue: string;
  region: Region;
  assetClass: Feed['assetClass'];
  status: FeedHealth;
  latencyUs: number | null;
  messagesPerSec: number | null;
  gapCount: number | null;
  recordedAt: string | null;
  stale: boolean;
};

export type FeedStatusResponse = { checkedAt: string; feeds: FeedStatus[] };

/** One time bucket of a feed's history (see GET /api/feeds/:code/metrics). */
export type MetricPoint = {
  t: string;
  status: 'up' | 'degraded' | 'down';
  avgLatencyUs: number | null;
  maxLatencyUs: number | null;
  messagesPerSec: number;
  gapCount: number;
};

export type FeedMetricsResponse = {
  feed: { code: string; name: string };
  minutes: number;
  bucketSeconds: number;
  points: MetricPoint[];
};

// --- Errors ----------------------------------------------------------------

/** Thrown for any non-2xx response, carrying the API's error code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// --- Core request helper ---------------------------------------------------

type RequestOptions = {
  signal?: AbortSignal;
  /** Non-2xx statuses that still carry a normal response body. */
  alsoAccept?: number[];
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (err) {
    // Aborts are intentional (component unmounted); let them pass through.
    if ((err as Error).name === 'AbortError') throw err;
    // fetch only rejects on *network* failure (API not running, offline).
    throw new ApiError(0, 'network_error', 'Could not reach the API. Is it running?');
  }

  // Parse the body first: error responses carry useful JSON too.
  const body: unknown = await res.json().catch(() => null);

  // A 5xx with no JSON body usually means the dev proxy couldn't reach the
  // API at all (it isn't running), rather than the API reporting an error.
  if (res.status >= 500 && body === null) {
    throw new ApiError(res.status, 'api_unreachable', 'The API is not responding. Is it running?');
  }

  if (!res.ok && !options.alsoAccept?.includes(res.status)) {
    const apiError = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      apiError?.code ?? 'http_error',
      apiError?.message ?? `Request failed with status ${res.status}`,
    );
  }

  return body as T;
}

// --- Endpoints -------------------------------------------------------------

function buildFeedsUrl(region?: Region): string {
  const params = new URLSearchParams();
  if (region) params.append('region', region);
  const query = params.toString();
  return query ? `/feeds?${query}` : '/feeds';
}

export const api = {
  // Health returns 503 when a dependency is down, but the body still says
  // exactly what's wrong, so treat 503 as a normal answer, not a failure.
  getHealth: (signal?: AbortSignal) => request<Health>('/health', { signal, alsoAccept: [503] }),

  getFeeds: async (region?: Region, signal?: AbortSignal) => {
    const data = await request<{ feeds: Feed[] }>(buildFeedsUrl(region), { signal });
    return data.feeds;
  },

  getFeedStatus: (signal?: AbortSignal) => request<FeedStatusResponse>('/feeds/status', { signal }),

  getFeedMetrics: (code: string, minutes: number, signal?: AbortSignal) =>
    request<FeedMetricsResponse>(`/feeds/${encodeURIComponent(code)}/metrics?minutes=${minutes}`, {
      signal,
    }),
};
