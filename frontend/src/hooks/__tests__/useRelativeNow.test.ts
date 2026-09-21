import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRelativeNow } from "../useRelativeNow";

afterEach(() => {
  vi.useRealTimers();
});

describe("useRelativeNow", () => {
  it("advances after the interval elapses", () => {
    vi.useFakeTimers();
    const start = Date.now();

    const { result } = renderHook(() => useRelativeNow(1000));
    expect(result.current).toBe(start);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toBe(start + 1000);
  });

  it("clears the interval on unmount", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const { unmount } = renderHook(() => useRelativeNow(1000));
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
