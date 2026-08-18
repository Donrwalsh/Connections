import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  filterPuzzleBreakdowns,
  formatDuration,
  sortPuzzleBreakdowns,
} from "../../../data/benchmark/metrics";
import { getStrategyAggregate, getStrategyPuzzleBreakdown } from "../../../data/benchmark/mockData";
import { StrategyPuzzlePage } from "../StrategyPuzzlePage";

function renderStrategy(strategyId = "alphabetical") {
  render(
    <MemoryRouter initialEntries={[`/leaderboard/${strategyId}`]}>
      <Routes>
        <Route path="/leaderboard/:strategyId" element={<StrategyPuzzlePage />} />
        <Route
          path="/leaderboard/:strategyId/:puzzleId"
          element={<div>runs-page</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table");
  return within(table).getAllByRole("link");
}

describe("StrategyPuzzlePage", () => {
  it("renders the strategy header with its aggregate summary", () => {
    const strategy = getStrategyAggregate("alphabetical")!;

    renderStrategy("alphabetical");

    expect(screen.getByRole("heading", { name: strategy.name })).toBeInTheDocument();
    expect(screen.getByText(strategy.description)).toBeInTheDocument();
    expect(
      screen.getByText(`${Math.round(strategy.successRate!)}%`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `${strategy.avgDurationMs === null ? "—" : formatDuration(strategy.avgDurationMs)}`,
      ),
    ).toBeInTheDocument();
  });

  it("lists every ingested puzzle for the strategy", () => {
    renderStrategy("alphabetical");

    const rows = bodyRows();
    expect(rows.length).toBe(getStrategyPuzzleBreakdown("alphabetical").length);
    expect(rows[0]!.textContent).toContain("1 / 1 runs complete");
  });

  it("sorts puzzles by average guesses ascending by default", () => {
    renderStrategy("alphabetical");

    const puzzles = getStrategyPuzzleBreakdown("alphabetical");
    const expected = sortPuzzleBreakdowns(puzzles, "asc").map((p) => p.puzzleId);
    const actual = bodyRows().map((row) =>
      Number(within(row).getByText(/^#\d+$/).textContent?.slice(1)),
    );
    expect(actual).toEqual(expected);
  });

  it("filters by run status", async () => {
    const user = userEvent.setup();
    const puzzles = getStrategyPuzzleBreakdown("gpt-4.1-nano-2025-04-14");

    renderStrategy("gpt-4.1-nano-2025-04-14");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");

    expect(bodyRows().length).toBe(filterPuzzleBreakdowns(puzzles, "failed").length);
  });

  it("navigates to the runs page when a puzzle row is clicked", async () => {
    const user = userEvent.setup();
    renderStrategy("alphabetical");

    await user.click(bodyRows()[0]!);

    expect(screen.getByText("runs-page")).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown strategy", () => {
    renderStrategy("does-not-exist");

    expect(screen.getByText("Unknown strategy.")).toBeInTheDocument();
  });
});
