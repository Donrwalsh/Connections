import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FreeTierUsage, Leaderboard, LeaderboardRow } from "../../../data/benchmark/types";
import { LeaderboardPage } from "../LeaderboardPage";

const flagshipUsage: FreeTierUsage = {
  tier: "flagship",
  label: "Flagship models",
  usedTokens: 12_000,
  dailyLimitTokens: 250_000,
  remainingTokens: 238_000,
  models: ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"],
};

const miniUsage: FreeTierUsage = {
  tier: "mini",
  label: "Mini & nano models",
  usedTokens: 500_000,
  dailyLimitTokens: 2_500_000,
  remainingTokens: 2_000_000,
  models: [
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5-mini",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o-mini",
    "o3-mini",
    "o4-mini",
    "gpt-5-nano",
  ],
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

const leaderboard: Leaderboard = {
  deterministic: [
    makeRow({ id: "alphabetical", strategyName: "alphabetical", successRate: 100, avgGuessesToSolve: 12 }),
    makeRow({
      id: "shuffle-foolish",
      strategyName: "shuffle-foolish",
      successRate: 60,
      avgGuessesToSolve: 30,
      progress: { completed: 6, active: 1, failed: 4, queued: 2 },
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
      progress: { completed: 4, active: 1, failed: 1, queued: 3 },
      avgCostUsd: 0.1234,
      totalCostUsd: 0.4936,
    }),
  ],
};

function stubFetch(data: Leaderboard, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      // The page's two FreeTierBudgetWidget instances each fetch
      // independently of the leaderboard — give them real-shaped responses
      // so neither renders an error state (or crashes on a mismatched
      // shape) in tests that only care about the leaderboard tables.
      const href = String(url);
      if (href.includes("/strategy/free-tier-usage/flagship")) {
        return Promise.resolve({ ok: true, json: async () => flagshipUsage });
      }
      if (href.includes("/strategy/free-tier-usage/mini")) {
        return Promise.resolve({ ok: true, json: async () => miniUsage });
      }
      return ok
        ? Promise.resolve({ ok: true, json: async () => data })
        : Promise.resolve({ ok: false, status: 500, json: async () => ({ message: "boom" }) });
    }),
  );
}

function renderLeaderboard() {
  // A fresh, retry-disabled client per test: react-query's default retry
  // behavior would otherwise keep the "fetch fails" test's error hidden
  // behind several rounds of exponential-backoff retries.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/leaderboard"]}>
        <Routes>
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/leaderboard/:strategyId" element={<div>strategy-details</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function firstRowIn(table: HTMLElement): HTMLElement {
  return within(table).getAllByRole("link")[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LeaderboardPage", () => {
  it("renders the hero, status strip, and both tables split by kind", async () => {
    stubFetch(leaderboard);
    renderLeaderboard();

    expect(screen.getByRole("heading", { name: "Connections Lab" })).toBeInTheDocument();
    expect(screen.getByText("Loading leaderboard…")).toBeInTheDocument();

    const tables = await screen.findAllByRole("table");
    expect(tables).toHaveLength(2);
    // LLM table renders first, deterministic & shuffle second.
    expect(within(tables[0]!).getAllByRole("link")).toHaveLength(1);
    expect(within(tables[1]!).getAllByRole("link")).toHaveLength(2);
    expect(screen.getByText("Alphabetical")).toBeInTheDocument();
    expect(screen.getByText(/gpt-4\.1-nano-2025-04-14/)).toBeInTheDocument();
  });

  it("shows the right column set per table: LLM gets success rate/avg duration/avg cost, deterministic gets avg speed/guesses/range", async () => {
    stubFetch(leaderboard);
    renderLeaderboard();

    const tables = await screen.findAllByRole("table");

    // LLM table (first): Success rate, Avg duration, Avg cost — no Avg
    // guesses, Range, or Avg speed (that's the deterministic table's
    // solves/hr framing; LLM shows raw wall-clock duration instead).
    expect(within(tables[0]!).getByRole("columnheader", { name: "Success rate" })).toBeInTheDocument();
    expect(within(tables[0]!).getByRole("columnheader", { name: "Avg duration" })).toBeInTheDocument();
    expect(within(tables[0]!).getByRole("columnheader", { name: "Avg cost" })).toBeInTheDocument();
    expect(
      within(tables[0]!).queryByRole("columnheader", { name: "Avg guesses" }),
    ).not.toBeInTheDocument();
    expect(within(tables[0]!).queryByRole("columnheader", { name: "Range" })).not.toBeInTheDocument();
    expect(within(tables[0]!).queryByRole("columnheader", { name: "Avg speed" })).not.toBeInTheDocument();
    expect(within(tables[0]!).getByText("80%")).toBeInTheDocument();
    expect(within(tables[0]!).getByText("$0.12")).toBeInTheDocument();
    // gpt row: avgDurationMs 12 -> raw duration, not a derived solves/hr rate.
    expect(firstRowIn(tables[0]!).textContent).toContain("12ms");

    // Deterministic table (second): Avg speed, Avg guesses, Range — no
    // Success rate, Avg cost, or Avg duration (deterministic strategies have
    // no LLM cost concept, and their near-instant runs read better as a
    // derived solves/hr rate than a raw millisecond duration).
    expect(within(tables[1]!).getByRole("columnheader", { name: "Avg speed" })).toBeInTheDocument();
    expect(within(tables[1]!).getByRole("columnheader", { name: "Avg guesses" })).toBeInTheDocument();
    expect(within(tables[1]!).getByRole("columnheader", { name: "Range" })).toBeInTheDocument();
    expect(
      within(tables[1]!).queryByRole("columnheader", { name: "Success rate" }),
    ).not.toBeInTheDocument();
    expect(within(tables[1]!).queryByRole("columnheader", { name: "Avg cost" })).not.toBeInTheDocument();
    expect(
      within(tables[1]!).queryByRole("columnheader", { name: "Avg duration" }),
    ).not.toBeInTheDocument();
    // alphabetical row: avgDurationMs 12 -> 3,600,000 / 12 = 300,000 solves/hr,
    // shown as a value line plus a "solves/hr" unit caption underneath.
    expect(firstRowIn(tables[1]!).textContent).toContain("300,000solves/hr");
  });

  it("formats Progress column numbers over 999 with thousands separators", async () => {
    stubFetch({
      deterministic: [
        makeRow({
          id: "alphabetical",
          puzzlesCovered: 1174,
          totalPuzzles: 1174,
          progress: { completed: 1174, active: 0, failed: 0, queued: 1500 },
        }),
      ],
      llm: [],
    });
    renderLeaderboard();

    const table = await screen.findByRole("table");
    expect(firstRowIn(table).textContent).toContain("1,174 of 1,174 puzzles");
    expect(within(table).getByText("Queued 1,500")).toBeInTheDocument();
  });

  it("summarizes in-flight work across both tables in the status strip", async () => {
    stubFetch(leaderboard);
    renderLeaderboard();

    await screen.findAllByRole("table");

    // active: 0 (alphabetical) + 1 (shuffle-foolish) + 1 (gpt row) = 2
    // queued: 0 + 2 + 3 = 5
    expect(screen.getByText("2 running")).toBeInTheDocument();
    expect(screen.getByText("5 queued")).toBeInTheDocument();
  });

  it("marks the top-ranked row per the default metric as leading, independently per table", async () => {
    stubFetch(leaderboard);
    renderLeaderboard();

    const tables = await screen.findAllByRole("table");
    // Default metric is now successRate, best first: alphabetical (100%)
    // beats shuffle-foolish (60%) in the deterministic table (second — LLM
    // renders first).
    expect(firstRowIn(tables[1]!)).toHaveClass("bench-row--leading");
    expect(firstRowIn(tables[1]!).textContent).toContain("Alphabetical");
  });

  it("re-ranks the leading row when the metric changes", async () => {
    const user = userEvent.setup();
    // alphabetical wins on the default metric (successRate); shuffle-foolish
    // wins on avgGuesses — so switching to it should flip which row leads.
    stubFetch({
      deterministic: [
        makeRow({ id: "alphabetical", strategyName: "alphabetical", successRate: 100, avgGuessesToSolve: 30 }),
        makeRow({
          id: "shuffle-foolish",
          strategyName: "shuffle-foolish",
          successRate: 60,
          avgGuessesToSolve: 12,
        }),
      ],
      llm: [],
    });
    renderLeaderboard();

    const tableBefore = await screen.findByRole("table");
    expect(firstRowIn(tableBefore).textContent).toContain("Alphabetical");

    await user.click(screen.getByRole("button", { name: "Avg guesses" }));

    const tableAfter = screen.getByRole("table");
    expect(firstRowIn(tableAfter).textContent).toContain("Shuffle-Foolish");
  });

  it("badges an LLM row whose model belongs to the flagship free tier", async () => {
    stubFetch({
      deterministic: leaderboard.deterministic,
      llm: [makeRow({ id: "gpt-5", strategyName: "llm-openai", modelName: "gpt-5", kind: "llm" })],
    });
    renderLeaderboard();

    expect(await screen.findByText("Flagship")).toBeInTheDocument();
    expect(screen.queryByText("Mini")).not.toBeInTheDocument();
  });

  it("badges an LLM row whose model belongs to the mini free tier", async () => {
    stubFetch({
      deterministic: leaderboard.deterministic,
      llm: [makeRow({ id: "o4-mini", strategyName: "llm-openai", modelName: "o4-mini", kind: "llm" })],
    });
    renderLeaderboard();

    expect(await screen.findByText("Mini")).toBeInTheDocument();
    expect(screen.queryByText("Flagship")).not.toBeInTheDocument();
  });

  it("shows no free-tier badge for a model in neither program", async () => {
    stubFetch(leaderboard); // gpt-4.1-nano-2025-04-14, a dated snapshot name in neither list
    renderLeaderboard();

    await screen.findAllByRole("table");
    expect(screen.queryByText("Flagship")).not.toBeInTheDocument();
    expect(screen.queryByText("Mini")).not.toBeInTheDocument();
  });

  it("navigates to the row detail page on click", async () => {
    const user = userEvent.setup();
    stubFetch(leaderboard);
    renderLeaderboard();

    const tables = await screen.findAllByRole("table");
    await user.click(firstRowIn(tables[0]!));

    expect(screen.getByText("strategy-details")).toBeInTheDocument();
  });

  it("shows an empty state for a table with no rows yet, without hiding the other table", async () => {
    stubFetch({ deterministic: [], llm: leaderboard.llm });
    renderLeaderboard();

    expect(await screen.findByText("No deterministic or shuffle runs yet.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("shows an error message when the leaderboard fetch fails", async () => {
    stubFetch(leaderboard, false);
    renderLeaderboard();

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("leaves a clearly marked stub for the coverage calendar", async () => {
    stubFetch(leaderboard);
    renderLeaderboard();

    await screen.findAllByRole("table");
    expect(screen.getByRole("region", { name: "Puzzle coverage calendar" })).toBeInTheDocument();
    expect(screen.getByText(/calendar will be built here next/)).toBeInTheDocument();
  });
});
