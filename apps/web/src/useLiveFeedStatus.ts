import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { StatusEvent } from './api';
import { queryKeys } from './queries';

/** Where the live connection is: shown to the user as a small badge. */
export type LiveState = 'connecting' | 'live' | 'slow' | 'reconnecting';

// If the stream fails in a way the browser won't retry by itself (see below),
// try again after this long.
const RECONNECT_MS = 3_000;

// No 'tick' event for this long while still connected = ticks have paused
// (e.g. Redis is down). Twice the heartbeat interval, so one late tick
// doesn't flip the badge.
const TICKS_PAUSED_AFTER_MS = 10_000;

/**
 * Listens to the API's live status stream (Server-Sent Events) and drops each
 * snapshot straight into TanStack Query's cache, under the same key that
 * useFeedStatus() reads. Components don't change at all: they just see the
 * cached data update the moment the server pushes it.
 *
 * Call this ONCE (in FeedStatusGrid). Each call opens its own connection.
 */
export function useLiveFeedStatus(): LiveState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  // When the last 'tick' arrived. A ref, not state: changing it shouldn't
  // re-render anything by itself; it's only read when the next event arrives.
  const lastTickAt = useRef(0);

  useEffect(() => {
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      // EventSource is the browser's built-in SSE client.
      source = new EventSource('/api/feeds/status/stream');

      source.addEventListener('status', (event) => {
        const { trigger, snapshot } = JSON.parse(event.data) as StatusEvent;
        // Put the pushed snapshot in the cache, exactly as if a fetch had
        // returned it. Every component using this key re-renders.
        queryClient.setQueryData(queryKeys.feedStatus, snapshot);

        if (trigger === 'heartbeat') {
          // Only heartbeats lately? Then per-tick updates have paused.
          const paused = Date.now() - lastTickAt.current > TICKS_PAUSED_AFTER_MS;
          setState(paused ? 'slow' : 'live');
        } else {
          // 'tick', or the first 'snapshot' after (re)connecting: assume ticks
          // are flowing; if they aren't, the heartbeats will say so soon.
          lastTickAt.current = Date.now();
          setState('live');
        }
      });

      source.onerror = () => {
        setState('reconnecting');
        // EventSource retries dropped connections by itself (readyState goes
        // back to CONNECTING). But if the server answered with an error, e.g.
        // the API is down and the dev proxy returns 502, it gives up for good
        // (CLOSED). In that case, start over ourselves after a pause.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retryTimer = setTimeout(connect, RECONNECT_MS);
        }
      };
    }

    connect();

    // Unmount (or StrictMode's dev double-run): close the stream and any retry.
    return () => {
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);

  return state;
}
