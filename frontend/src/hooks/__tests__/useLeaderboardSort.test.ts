import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLeaderboardSort } from "../useLeaderboardSort";

describe("useLeaderboardSort", () => {
  it("starts on the given column, in its best-first direction", () => {
    const { result } = renderHook(() => useLeaderboardSort("avgGuesses"));

    expect(result.current.sortBy).toBe("avgGuesses");
    expect(result.current.sortDir).toBe("asc");
  });

  it("clicking the active column flips ascending/descending", () => {
    const { result } = renderHook(() => useLeaderboardSort("avgGuesses"));

    act(() => result.current.onSortChange("avgGuesses"));
    expect(result.current.sortBy).toBe("avgGuesses");
    expect(result.current.sortDir).toBe("desc");

    act(() => result.current.onSortChange("avgGuesses"));
    expect(result.current.sortDir).toBe("asc");
  });

  it("clicking a different column switches to it in its own best-first direction", () => {
    const { result } = renderHook(() => useLeaderboardSort("avgGuesses"));

    act(() => result.current.onSortChange("range"));
    expect(result.current.sortBy).toBe("range");
    expect(result.current.sortDir).toBe("asc");

    act(() => result.current.onSortChange("successRate"));
    expect(result.current.sortBy).toBe("successRate");
    expect(result.current.sortDir).toBe("desc");
  });
});
