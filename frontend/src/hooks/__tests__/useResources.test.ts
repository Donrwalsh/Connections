import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResources } from "../useResources";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useResources", () => {
  it("fetches every id in parallel", async () => {
    const fetcher = vi.fn((id: string): Promise<string> => Promise.resolve(`${id}-data`));
    const { result } = renderHook(() => useResources("key", ["a", "b"], fetcher));

    expect(result.current.a.loading).toBe(true);
    expect(result.current.b.loading).toBe(true);

    await waitFor(() => expect(result.current.a.data).toBe("a-data"));
    await waitFor(() => expect(result.current.b.data).toBe("b-data"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a key change resets and refetches every id", async () => {
    const fetcher = vi.fn((id: string): Promise<string> => Promise.resolve(`${id}-v1`));
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useResources(key, ["a", "b"], fetcher),
      { initialProps: { key: "k1" } },
    );

    await waitFor(() => expect(result.current.a.data).toBe("a-v1"));

    fetcher.mockImplementation((id: string) => Promise.resolve(`${id}-v2`));
    rerender({ key: "k2" });

    await waitFor(() => expect(result.current.a.data).toBe("a-v2"));
    await waitFor(() => expect(result.current.b.data).toBe("b-v2"));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("a superseded resolve for one id doesn't clobber that id's fresh data, and doesn't touch sibling ids", async () => {
    const aFirst = deferred<string>();
    const aSecond = deferred<string>();
    let aCalls = 0;
    const fetcher = vi.fn((id: string) => {
      if (id === "a") {
        aCalls += 1;
        return aCalls === 1 ? aFirst.promise : aSecond.promise;
      }
      return Promise.resolve("b-data");
    });

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useResources(key, ["a", "b"], fetcher),
      { initialProps: { key: "k1" } },
    );
    await waitFor(() => expect(result.current.b.data).toBe("b-data"));

    rerender({ key: "k2" });

    act(() => aFirst.resolve("stale"));
    await Promise.resolve();
    expect(result.current.a.data).toBeUndefined();

    act(() => aSecond.resolve("fresh"));
    await waitFor(() => expect(result.current.a.data).toBe("fresh"));
    expect(result.current.b.data).toBe("b-data");
  });

  it("per-id refetch() only re-runs that id", async () => {
    const fetcher = vi
      .fn<(id: string, signal: AbortSignal) => Promise<string>>()
      .mockImplementation((id) => Promise.resolve(`${id}-1`));

    const { result } = renderHook(() => useResources("k", ["a", "b"], fetcher));
    await waitFor(() => expect(result.current.a.data).toBe("a-1"));
    await waitFor(() => expect(result.current.b.data).toBe("b-1"));

    fetcher.mockImplementation((id) => Promise.resolve(`${id}-2`));
    act(() => result.current.a.refetch());

    await waitFor(() => expect(result.current.a.data).toBe("a-2"));
    expect(result.current.b.data).toBe("b-1");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
