import { useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => void;
}

export interface UseResourceOpts {
  /** Default true. When false, fetching is skipped and the previously loaded
   * data/error is preserved (not cleared) rather than reset to empty. */
  enabled?: boolean;
  /** Default false. When true, a key change keeps the previous data/error
   * visible (stale) while `loading` flips true for the new fetch, instead of
   * resetting to undefined first. */
  keepPreviousData?: boolean;
  /** When set, refetches on this cadence (ms) in addition to the initial
   * fetch and any key change, until unmount or `enabled` goes false. A
   * manual `refetch()` call does not reset this interval's own schedule. */
  refetchInterval?: number;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Fetch lifecycle in one hook: abort-on-key-change, abort-on-unmount, a
 * stale-resolve guard beyond what AbortSignal alone catches, loading/error
 * state, and `refetch()`. `key` is JSON.stringified internally, so callers
 * can pass array/object literals inline without memoizing them. */
export function useResource<T>(
  key: unknown,
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: UseResourceOpts = {},
): Resource<T> {
  const { enabled = true, keepPreviousData = false, refetchInterval } = opts;
  const stringKey = JSON.stringify(key);

  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(enabled);

  // Read via a ref so a fresh fetcher closure every render doesn't need to be
  // memoized by the caller or force the effect below to re-run.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const runFetch = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;

    setLoading(true);
    setError(undefined);
    if (!keepPreviousData) setData(undefined);

    fetcherRef.current(controller.signal)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== requestId) return;
        setError(toError(err));
        setLoading(false);
      });
  }, [keepPreviousData]);

  useEffect(() => {
    if (!enabled) {
      controllerRef.current?.abort();
      setLoading(false);
      return;
    }

    runFetch();

    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (refetchInterval) {
      intervalId = setInterval(runFetch, refetchInterval);
    }

    return () => {
      controllerRef.current?.abort();
      if (intervalId) clearInterval(intervalId);
    };
    // stringKey stands in for `key` (any identity, compared by value); runFetch
    // already captures the latest fetcher/keepPreviousData via its own deps.
  }, [stringKey, enabled, refetchInterval, runFetch]);

  const refetch = useCallback(() => {
    if (!enabled) return;
    runFetch();
  }, [enabled, runFetch]);

  return { data, error, loading, refetch };
}
