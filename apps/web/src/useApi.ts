import { useCallback, useEffect, useState } from 'react';

type State<T> =
  | { status: 'loading'; data?: T; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: T; error: Error };

/**
 * A small hand-written data-fetching hook. In Phase 3 we replace it with
 * TanStack Query, which handles caching, refetching and polling for us.
 * Writing it by hand first shows what that library is doing under the hood.
 *
 * Usage:  const feeds = useApi(api.getFeeds);
 *
 * `fetcher` should be a stable function (defined outside the component, like
 * the methods on `api`), otherwise the effect would re-run every render.
 */
export function useApi<T>(fetcher: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<State<T>>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // AbortController lets us cancel the request if the component unmounts
    // (or reloads) before it finishes, so we never set state on a component
    // that's gone, and a slow old response can't overwrite a newer one.
    const controller = new AbortController();

    // Keep showing the previous data while reloading (no flash of empty UI).
    setState((prev) => ({ status: 'loading', data: prev.data }));

    fetcher(controller.signal)
      .then((data) => setState({ status: 'success', data }))
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        setState((prev) => ({ status: 'error', error, data: prev.data }));
      });

    // React runs this cleanup before the next effect run and on unmount.
    return () => controller.abort();
  }, [fetcher, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { ...state, reload };
}
