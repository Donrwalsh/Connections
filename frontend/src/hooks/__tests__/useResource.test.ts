import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResource } from "../useResource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useResource", () => {
  it("fetches on mount and resolves into data", async () => {
    const fetcher = vi.fn((): Promise<string> => Promise.resolve("hello"));
    const { result } = renderHook(() => useResource("key-1", fetcher));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBe("hello");
    expect(result.current.error).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("normalizes a non-Error rejection into an Error", async () => {
    const fetcher = vi.fn(() => Promise.reject("boom"));
    const { result } = renderHook(() => useResource("key-1", fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toBeUndefined();
  });

  it("aborts the in-flight request and refetches when the key changes", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useResource(key, fetcher),
      { initialProps: { key: "a" } },
    );

    rerender({ key: "b" });

    expect(signals[0]?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // The superseded first request resolving late must not clobber state.
    act(() => first.resolve("stale"));
    await Promise.resolve();
    expect(result.current.data).toBeUndefined();

    act(() => second.resolve("fresh"));
    await waitFor(() => expect(result.current.data).toBe("fresh"));
  });

  it("refetch() re-runs the fetcher with a fresh request", async () => {
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    const { result } = renderHook(() => useResource("k", fetcher));
    await waitFor(() => expect(result.current.data).toBe(1));

    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.data).toBe(2));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts the in-flight request on unmount", async () => {
    const fetcher = vi.fn<(signal: AbortSignal) => Promise<string>>(
      () => new Promise<string>(() => {}),
    );
    const { unmount } = renderHook(() => useResource("k", fetcher));

    const signal = fetcher.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("enabled:false skips fetching and preserves prior data; flipping true fetches immediately", async () => {
    const fetcher = vi.fn<(signal: AbortSignal) => Promise<string>>().mockResolvedValue("v1");

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useResource("k", fetcher, { enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.data).toBe("v1"));

    rerender({ enabled: false });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe("v1"); // preserved, not cleared

    fetcher.mockResolvedValue("v2");
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toBe("v2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keepPreviousData keeps stale data visible while a key change is loading", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;
    const fetcher = vi.fn(() => (++call === 1 ? first.promise : second.promise));

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useResource(key, fetcher, { keepPreviousData: true }),
      { initialProps: { key: "a" } },
    );

    act(() => first.resolve("v1"));
    await waitFor(() => expect(result.current.data).toBe("v1"));

    rerender({ key: "b" });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe("v1"); // stale but visible

    act(() => second.resolve("v2"));
    await waitFor(() => expect(result.current.data).toBe("v2"));
  });

  it("refetchInterval polls on a cadence and stops on unmount", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<(signal: AbortSignal) => Promise<number>>().mockResolvedValue(1);

    const { unmount } = renderHook(() =>
      useResource("k", fetcher, { refetchInterval: 1000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
