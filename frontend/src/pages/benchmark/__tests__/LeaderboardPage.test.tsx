import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Leaderboard, LeaderboardRow } from "../../../data/benchmark/types";
import { LeaderboardPage } from "../LeaderboardPage";

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
    }),
  ],
};

function stubFetch(data: Leaderboard, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      ok
        ? Promise.resolve({ ok: true, json: async () => data })
        : Promise.resolve({ ok: false, status: 500, json: async () => ({ message: "boom" }) }),
    ),
  );
}

function renderLeaderboard() {
  render(
    <MemoryRouter initialEntries={["/leaderboard"]}>
      <Routes>
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/leaderboard/:strategyId" element={<div>strategy-details</div>} />
      </Routes>
    </MemoryRouter>,
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
    expect(within(tables[0]!).getAllByRole("link")).toHaveLength(2);
    expect(within(tables[1]!).getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Alphabetical")).toBeInTheDocument();
    expect(screen.getByText(/gpt-4\.1-nano-2025-04-14/)).toBeInTheDocument();
  });

  it("shows the right column set per table: deterministic gets guesses/range, LLM gets success rate, both get avg speed", async () => {
    stubFetch(leaderboard);
    renderLeaderboard();

    const tables = await screen.findAllByRole("table");

    // Deterministic table: Avg speed, Avg guesses, Range — no Success rate.
    expect(within(tables[0]!).getByRole("columnheader", { name: "Avg speed" })).toBeInTheDocument();
    expect(within(tables[0]!).getByRole("columnheader", { name: "Avg guesses" })).toBeInTheDocument();
    expect(within(tables[0]!).getByRole("columnheader", { name: "Range" })).toBeInTheDocument();
    expect(
      within(tables[0]!).queryByRole("columnheader", { name: "Success rate" }),
    ).not.toBeInTheDocument();
    // alphabetical row: avgDurationMs 12 -> 3,600,000 / 12 = 300,000 solves/hr,
    // shown as a value line plus a "solves/hr" unit caption underneath.
    expect(firstRowIn(tables[0]!).textContent).toContain("300,000solves/hr");

    // LLM table: Success rate, Avg speed — no Avg guesses or Range.
    expect(within(tables[1]!).getByRole("columnheader", { name: "Success rate" })).toBeInTheDocument();
    expect(within(tables[1]!).getByRole("columnheader", { name: "Avg speed" })).toBeInTheDocument();
    expect(
      within(tables[1]!).queryByRole("columnheader", { name: "Avg guesses" }),
    ).not.toBeInTheDocument();
    expect(within(tables[1]!).queryByRole("columnheader", { name: "Range" })).not.toBeInTheDocument();
    expect(within(tables[1]!).getByText("80%")).toBeInTheDocument();
    // gpt row: avgDurationMs 12 (default) -> same 300,000 solves/hr.
    expect(firstRowIn(tables[1]!).textContent).toContain("300,000solves/hr");
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
    // avgGuesses, fewest first: alphabetical (12) beats shuffle-foolish (30).
    expect(firstRowIn(tables[0]!)).toHaveClass("bench-row--leading");
    expect(firstRowIn(tables[0]!).textContent).toContain("Alphabetical");
  });

  it("re-ranks the leading row when the metric changes", async () => {
    const user = userEvent.setup();
    stubFetch(leaderboard);
    renderLeaderboard();

    await screen.findAllByRole("table");
    await user.click(screen.getByRole("button", { name: "Success rate" }));

    const tables = screen.getAllByRole("table");
    // success rate, best first: alphabetical (100%) still leads over
    // shuffle-foolish (60%) in the deterministic table.
    expect(firstRowIn(tables[0]!).textContent).toContain("Alphabetical");
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
