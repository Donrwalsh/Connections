import { describe, expect, it } from "vitest";
import {
  defaultSortDir,
  formatSuccessRate,
  leaderboardSortValue,
  sortLeaderboardRows,
} from "./metrics";

const row = (id: string, categoryAccuracy: number | null) =>
  ({
    id,
    avgGuessesToSolve: null,
    successRate: null,
    avgDurationMs: null,
    categoryAccuracy,
    maxGuesses: null,
    puzzlesCovered: 0,
  }) as never;

const namedRow = (name: string) =>
  ({
    id: name,
    name,
    avgGuessesToSolve: null,
    successRate: null,
    avgDurationMs: null,
    categoryAccuracy: null,
    maxGuesses: null,
    puzzlesCovered: 0,
  }) as never;

describe("categoryAccuracy sort column", () => {
  it("sorts highest accuracy first (desc, its default direction), nulls last", () => {
    const sorted = sortLeaderboardRows(
      [row("a", 40), row("b", null), row("c", 90)],
      "categoryAccuracy",
      defaultSortDir("categoryAccuracy"),
    );
    expect(sorted.map((r) => (r as { id: string }).id)).toEqual(["c", "a", "b"]);
  });

  it("reads the raw value off a row", () => {
    expect(leaderboardSortValue(row("a", 33.333), "categoryAccuracy")).toBeCloseTo(33.333);
  });
});

describe("defaultSortDir", () => {
  it("defaults higher-is-better columns to descending", () => {
    expect(defaultSortDir("successRate")).toBe("desc");
    expect(defaultSortDir("speed")).toBe("desc");
    expect(defaultSortDir("categoryAccuracy")).toBe("desc");
    expect(defaultSortDir("progress")).toBe("desc");
  });

  it("defaults lower-is-better columns to ascending", () => {
    expect(defaultSortDir("avgGuesses")).toBe("asc");
    expect(defaultSortDir("duration")).toBe("asc");
    expect(defaultSortDir("range")).toBe("asc");
  });

  it("defaults the name column to ascending (A first)", () => {
    expect(defaultSortDir("name")).toBe("asc");
  });
});

describe("name sort column", () => {
  it("sorts alphabetically ascending", () => {
    const sorted = sortLeaderboardRows(
      [namedRow("Reverse-Alphabetical"), namedRow("Alphabetical"), namedRow("Order")],
      "name",
      "asc",
    );
    expect(sorted.map((r) => (r as { name: string }).name)).toEqual([
      "Alphabetical",
      "Order",
      "Reverse-Alphabetical",
    ]);
  });

  it("reverses to descending", () => {
    const sorted = sortLeaderboardRows(
      [namedRow("Reverse-Alphabetical"), namedRow("Alphabetical"), namedRow("Order")],
      "name",
      "desc",
    );
    expect(sorted.map((r) => (r as { name: string }).name)).toEqual([
      "Reverse-Alphabetical",
      "Order",
      "Alphabetical",
    ]);
  });

  it("reads the raw string value off a row", () => {
    expect(leaderboardSortValue(namedRow("Alphabetical"), "name")).toBe("Alphabetical");
  });
});

describe("sortLeaderboardRows direction toggle", () => {
  it("reverses order when given the opposite direction", () => {
    const rows = [row("a", 40), row("c", 90), row("b", 10)];
    const desc = sortLeaderboardRows(rows, "categoryAccuracy", "desc").map((r) => (r as { id: string }).id);
    const asc = sortLeaderboardRows(rows, "categoryAccuracy", "asc").map((r) => (r as { id: string }).id);
    expect(desc).toEqual(["c", "a", "b"]);
    expect(asc).toEqual(["b", "a", "c"]);
  });
});

describe("formatSuccessRate", () => {
  it("shows 3 significant figures for a low rate instead of rounding to 0%", () => {
    expect(formatSuccessRate(0.333)).toBe("0.333%");
  });

  it("doesn't pad a round number with trailing zeros", () => {
    expect(formatSuccessRate(100)).toBe("100%");
    expect(formatSuccessRate(5)).toBe("5%");
  });

  it("rounds rather than truncates", () => {
    expect(formatSuccessRate(45.678)).toBe("45.7%");
  });
});
