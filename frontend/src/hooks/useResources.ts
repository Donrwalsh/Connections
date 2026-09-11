import { useCallback, useEffect, useRef, useState } from "react";
import type { Resource, UseResourceOpts } from "./useResource";

interface InternalState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** `useResource`'s sibling for a parallel fetch per id in a list (e.g. one
 * request per strategy). `key` changing resets and refetches every id in
 * `ids`; each id also gets its own independent `refetch()`. `ids` need not
 * be referentially stable across renders — only its JSON-serialisable
 * content is compared. */
export function useResources<K extends string, T>(
  key: unknown,
  ids: readonly K[],
  fetcher: (id: K, signal: AbortSignal) => Promise<T>,
  opts: UseResourceOpts = {},
): Record<K, Resource<T>> {
  const { enabled = true, keepPreviousData = false, refetchInterval } = opts;
  const stringKey = JSON.stringify(key);
  const idsKey = JSON.stringify(ids);

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const [states, setStates] = useState<Record<string, InternalState<T>>>({});

  const controllersRef = useRef<Record<string, AbortController>>({});
  const requestIdsRef = useRef<Record<string, number>>({});

  const runOne = useCallback(
    (id: K) => {
      controllersRef.current[id]?.abort();
      const controller = new AbortController();
      controllersRef.current[id] = controller;
      const requestId = (requestIdsRef.current[id] ?? 0) + 1;
      requestIdsRef.current[id] = requestId;

      setStates((prev) => ({
        ...prev,
        [id]: {
          data: keepPreviousData ? prev[id]?.data : undefined,
          error: undefined,
          loading: true,
        },
      }));

      fetcherRef.current(id, controller.signal)
        .then((result) => {
          if (requestIdsRef.current[id] !== requestId) return;
          setStates((prev) => ({ ...prev, [id]: { data: result, error: undefined, loading: false } }));
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (requestIdsRef.current[id] !== requestId) return;
          setStates((prev) => ({
            ...prev,
            [id]: { data: prev[id]?.data, error: toError(err), loading: false },
          }));
        });
    },
    [keepPreviousData],
  );

  const runAll = useCallback(
    (idList: readonly K[]) => idList.forEach(runOne),
    [runOne],
  );

  useEffect(() => {
    if (!enabled) {
      Object.values(controllersRef.current).forEach((c) => c.abort());
      setStates((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          next[id] = { data: next[id]?.data, error: next[id]?.error, loading: false };
        });
        return next;
      });
      return;
    }

    runAll(ids);

    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (refetchInterval) {
      intervalId = setInterval(() => runAll(ids), refetchInterval);
    }

    const controllers = controllersRef.current;
    return () => {
      ids.forEach((id) => controllers[id]?.abort());
      if (intervalId) clearInterval(intervalId);
    };
    // stringKey/idsKey stand in for `key`/`ids` (compared by value).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stringKey, idsKey, enabled, refetchInterval, runAll]);

  const result = {} as Record<K, Resource<T>>;
  ids.forEach((id) => {
    const s = states[id] ?? { data: undefined, error: undefined, loading: enabled };
    result[id] = {
      data: s.data,
      error: s.error,
      loading: s.loading,
      refetch: () => runOne(id),
    };
  });
  return result;
}
