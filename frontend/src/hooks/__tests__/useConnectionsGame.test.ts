import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Category } from "../../data/types";
import { useConnectionsGame } from "../useConnectionsGame";

const categories: Category[] = [
  {
    id: "cat-1",
    name: "WET WEATHER",
    difficulty: "yellow",
    words: ["HAIL", "RAIN", "SLEET", "SNOW"],
  },
  {
    id: "cat-2",
    name: "NBA TEAMS",
    difficulty: "green",
    words: ["BUCKS", "HEAT", "JAZZ", "NETS"],
  },
  {
    id: "cat-3",
    name: "KEYBOARD KEYS",
    difficulty: "blue",
    words: ["OPTION", "RETURN", "SHIFT", "TAB"],
  },
  {
    id: "cat-4",
    name: "PALINDROMES",
    difficulty: "purple",
    words: ["KAYAK", "LEVEL", "MOM", "RACECAR"],
  },
];

const words = categories.flatMap((c) => c.words);

describe("useConnectionsGame", () => {
  it("initializes in a playing state with an empty selection", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    expect(result.current.state.status).toBe("playing");
    expect(result.current.state.selected).toEqual([]);
    expect(result.current.state.solved).toEqual([]);
    expect(result.current.state.mistakes).toBe(0);
  });

  it("toggles words on and off", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    act(() => result.current.toggleWord("HAIL"));
    expect(result.current.state.selected).toEqual(["HAIL"]);

    act(() => result.current.toggleWord("RAIN"));
    expect(result.current.state.selected).toEqual(["HAIL", "RAIN"]);

    act(() => result.current.toggleWord("HAIL"));
    expect(result.current.state.selected).toEqual(["RAIN"]);
  });

  it("submits a correct guess and confirms the solve", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    categories[0].words.forEach((word) =>
      act(() => result.current.toggleWord(word)),
    );
    act(() => result.current.submitGuess());
    expect(result.current.state.pendingSolve).toEqual(categories[0]);

    act(() => result.current.confirmSolve());
    expect(result.current.state.solved).toEqual([categories[0]]);
    expect(result.current.state.pendingSolve).toBeNull();
  });

  it("records a mistake for a wrong guess", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    ["HAIL", "BUCKS", "OPTION", "KAYAK"].forEach((word) =>
      act(() => result.current.toggleWord(word)),
    );
    act(() => result.current.submitGuess());

    expect(result.current.state.mistakes).toBe(1);
    expect(result.current.state.feedback).toBe("incorrect");
    expect(result.current.state.selected).toEqual([]);
  });

  it("deselects all selected words", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    act(() => result.current.toggleWord("HAIL"));
    act(() => result.current.toggleWord("RAIN"));
    act(() => result.current.deselectAll());

    expect(result.current.state.selected).toEqual([]);
  });

  it("clears feedback and shake words", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    ["HAIL", "BUCKS", "OPTION", "KAYAK"].forEach((word) =>
      act(() => result.current.toggleWord(word)),
    );
    act(() => result.current.submitGuess());
    expect(result.current.state.feedback).toBe("incorrect");

    act(() => result.current.clearFeedback());
    expect(result.current.state.feedback).toBeNull();
    expect(result.current.state.shakeWords).toEqual([]);
  });

  it("shuffles the remaining words into a permutation", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    act(() => result.current.shuffleBoard());

    expect([...result.current.state.remainingWords].sort()).toEqual(
      [...words].sort(),
    );
  });

  it("handles the AI solve lifecycle", () => {
    const { result } = renderHook(() => useConnectionsGame(categories, words));

    act(() => result.current.aiSolve());
    expect(result.current.state.loading).toBe(true);

    act(() =>
      result.current.aiSolveSuccess({
        orchestrator: "healthy",
        data: {
          proposedGroup: {
            word_ids: [0, 1, 2, 3],
            category: "WET WEATHER",
            confidence: 0.9,
            reasoning: "Precipitation",
          },
          prompt: "Find the group",
        },
      }),
    );
    expect(result.current.state.loading).toBe(false);
    expect(result.current.state.ai_solution).toBeTruthy();

    act(() => result.current.aiSolveError("orchestrator down"));
    expect(result.current.state.error).toBe("orchestrator down");
    expect(result.current.state.ai_solution).toBeNull();
    expect(result.current.state.loading).toBe(false);
  });
});
