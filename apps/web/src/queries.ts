import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type Region } from './api';

/**
 * Every server-data hook the app uses, in one place.
 *
 * TanStack Query stores each response in a cache under its *query key*.
 * Two components asking for the same key share one request and one cached
 * result. Keys are arrays so they can include parameters: each region's
 * feed list gets its own cache entry.
 */
export const queryKeys = {
  health: ['health'] as const,
  feeds: (region?: Region) => ['feeds', region ?? 'ALL'] as const,
  feedStatus: ['feedStatus'] as const,
  feedMetrics: (code: string, minutes: number) => ['feedMetrics', code, minutes] as const,
};

/** API + database + Redis health. Re-checks every 10 seconds on its own. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    // TanStack passes an AbortSignal; it cancels the request if nobody needs
    // the result any more (the same job our AbortController did by hand).
    queryFn: ({ signal }) => api.getHealth(signal),
    refetchInterval: 10_000,
  });
}

/**
 * The feed catalog, optionally filtered by region (filtered on the server).
 * The catalog rarely changes, so no polling.
 */
export function useFeeds(region?: Region) {
  return useQuery({
    // The region is part of the key, so changing it fetches (and caches)
    // a separate list. Switching back to a region you've seen is instant.
    queryKey: queryKeys.feeds(region),
    queryFn: ({ signal }) => api.getFeeds(region, signal),
    staleTime: 5 * 60_000, // treat it as fresh for 5 minutes
    // While a new region loads, keep showing the previous table instead of
    // flashing "Loading…" (the same thing useApi did with prev.data).
    placeholderData: keepPreviousData,
  });
}

/**
 * Every feed's latest health reading.
 *
 * While the live stream is connected (see useLiveFeedStatus), the server
 * pushes fresh data into this query's cache, so there's nothing to poll.
 * If the stream drops, polling every 3 seconds takes over as a fallback.
 */
export function useFeedStatus({ live }: { live: boolean }) {
  return useQuery({
    queryKey: queryKeys.feedStatus,
    queryFn: ({ signal }) => api.getFeedStatus(signal),
    refetchInterval: live ? false : 3_000,
    refetchOnWindowFocus: !live,
  });
}

/**
 * One feed's latency history for the chart. Pass null when no feed is
 * selected: `enabled: false` tells TanStack not to fetch at all.
 */
export function useFeedMetrics(code: string | null, minutes: number) {
  return useQuery({
    queryKey: queryKeys.feedMetrics(code ?? '', minutes),
    queryFn: ({ signal }) => api.getFeedMetrics(code!, minutes, signal),
    enabled: code !== null,
    refetchInterval: 5_000,
    // Switching feed or range keeps the old chart on screen (dimmed) until
    // the new data arrives, instead of collapsing to "Loading…".
    placeholderData: keepPreviousData,
  });
}
