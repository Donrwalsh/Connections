import type { Page } from "@playwright/test";
import type { Category, Puzzle } from "../src/data/types";
import type { FreeTierUsage, Leaderboard, LeaderboardRow } from "../src/data/benchmark/types";

const categories: Category[] = [
  { id: "cat-1", name: "WET WEATHER", difficulty: "yellow", words: ["HAIL", "RAIN", "SLEET", "SNOW"] },
  { id: "cat-2", name: "NBA TEAMS", difficulty: "green", words: ["BUCKS", "HEAT", "JAZZ", "NETS"] },
  { id: "cat-3", name: "KEYBOARD KEYS", difficulty: "blue", words: ["OPTION", "RETURN", "SHIFT", "TAB"] },
  { id: "cat-4", name: "PALINDROMES", difficulty: "purple", words: ["KAYAK", "LEVEL", "MOM", "RACECAR"] },
];

export const puzzleFixture: Puzzle = {
  id: 1,
  date: "2024-01-15",
  categories,
  wordOrder: categories.flatMap((c) => c.words),
  isImagePuzzle: false,
};

function makeRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    id: "alphabetical",
    strategyName: "alphabetical",
    modelName: null,
    kind: "deterministic",
    puzzlesCovered: 10,
    totalPuzzles: 12,
    progress: { completed: 10, active: 0, failed: 0, queued: 0 },
    successRate: 100,
    avgGuessesToSolve: 12,
    minGuesses: 4,
    maxGuesses: 40,
    avgDurationMs: 12,
    avgCostUsd: null,
    totalCostUsd: null,
    ...overrides,
  };
}

export const leaderboardFixture: Leaderboard = {
  deterministic: [
    makeRow({ id: "alphabetical", strategyName: "alphabetical" }),
    makeRow({
      id: "shuffle-foolish",
      strategyName: "shuffle-foolish",
      successRate: 60,
      avgGuessesToSolve: 30,
    }),
  ],
  llm: [
    makeRow({
      id: "gpt-4.1-nano-2025-04-14",
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano-2025-04-14",
      kind: "llm",
      successRate: 80,
      avgGuessesToSolve: 4.2,
      minGuesses: 2,
      maxGuesses: 8,
      avgCostUsd: 0.1234,
      totalCostUsd: 0.4936,
    }),
  ],
};

const flagshipUsage: FreeTierUsage = {
  tier: "flagship",
  label: "Flagship models",
  usedTokens: 12_000,
  dailyLimitTokens: 250_000,
  remainingTokens: 238_000,
  models: ["gpt-4.1"],
};

const miniUsage: FreeTierUsage = {
  tier: "mini",
  label: "Mini & nano models",
  usedTokens: 500_000,
  dailyLimitTokens: 2_500_000,
  remainingTokens: 2_000_000,
  models: ["gpt-4.1-nano"],
};

/** Mocks the /game/puzzle/* endpoint PuzzlePage fetches, for both
 * /puzzle/:date and the today-alias route. */
export async function mockPuzzle(page: Page): Promise<void> {
  await page.route("**/game/puzzle/**", (route) => route.fulfill({ json: puzzleFixture }));
}

/** Mocks every per-strategy run-list endpoint GuessSequencePanel fetches on
 * mount with an empty list — enough to exercise the panel's open/stack
 * behavior without needing real run data. */
export async function mockGuessSequenceRuns(page: Page): Promise<void> {
  await page.route("**/strategy/*/puzzle/*", (route) => route.fulfill({ json: [] }));
}

/** Mocks the leaderboard plus both free-tier-usage endpoints LeaderboardPage
 * fetches on load. */
export async function mockLeaderboard(page: Page): Promise<void> {
  await page.route("**/strategy/leaderboard", (route) => route.fulfill({ json: leaderboardFixture }));
  await page.route("**/strategy/free-tier-usage/flagship", (route) => route.fulfill({ json: flagshipUsage }));
  await page.route("**/strategy/free-tier-usage/mini", (route) => route.fulfill({ json: miniUsage }));
}
