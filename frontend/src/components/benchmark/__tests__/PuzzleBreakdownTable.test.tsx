import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  filterPuzzleBreakdowns,
  sortPuzzleBreakdowns,
} from "../../../data/benchmark/metrics";
import { getStrategyPuzzleBreakdown } from "../../../data/benchmark/mockData";
import { PuzzleBreakdownTable } from "../PuzzleBreakdownTable";

function renderTable(strategyId = "gpt-4.1-nano-2025-04-14") {
  render(
    <MemoryRouter initialEntries={[`/leaderboard/${strategyId}`]}>
      <Routes>
        <Route
          path="/leaderboard/:strategyId"
          element={<PuzzleBreakdownTable strategyId={strategyId} puzzles={getStrategyPuzzleBreakdown(strategyId)} />}
        />
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

describe("PuzzleBreakdownTable", () => {
  it("sorts puzzles by average guesses ascending (best first) by default", () => {
    const puzzles = getStrategyPuzzleBreakdown("gpt-4.1-nano-2025-04-14");
    const expected = sortPuzzleBreakdowns(puzzles, "asc").map((p) => p.puzzleId);

    renderTable("gpt-4.1-nano-2025-04-14");

    const rows = bodyRows();
    const actual = rows.map((row) =>
      Number(within(row).getByText(/^#\d+$/).textContent?.slice(1)),
    );
    expect(actual).toEqual(expected);
  });

  it("toggles the sort between best and worst performing", async () => {
    const user = userEvent.setup();
    const puzzles = getStrategyPuzzleBreakdown("gpt-4.1-nano-2025-04-14");
    const expected = sortPuzzleBreakdowns(puzzles, "desc").map((p) => p.puzzleId);

    renderTable("gpt-4.1-nano-2025-04-14");
    await user.click(screen.getByRole("button", { name: /average guesses/i }));

    const rows = bodyRows();
    const actual = rows.map((row) =>
      Number(within(row).getByText(/^#\d+$/).textContent?.slice(1)),
    );
    expect(actual).toEqual(expected);
  });

  it("filters by run status", async () => {
    const user = userEvent.setup();
    const puzzles = getStrategyPuzzleBreakdown("gpt-4.1-nano-2025-04-14");
    const expected = filterPuzzleBreakdowns(puzzles, "failed");

    renderTable("gpt-4.1-nano-2025-04-14");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");

    const rows = bodyRows();
    expect(rows.length).toBe(expected.length);
    expect(within(rows[0]!).getByText("Failed")).toBeInTheDocument();
  });

  it("navigates to the runs page when a puzzle row is clicked", async () => {
    const user = userEvent.setup();
    renderTable("gpt-4.1-nano-2025-04-14");

    await user.click(bodyRows()[0]!);

    expect(screen.getByText("runs-page")).toBeInTheDocument();
  });
});
