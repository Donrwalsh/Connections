import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { sortStrategiesByMetric } from "../../../data/benchmark/metrics";
import {
  getStrategyAggregates,
  summarizeProgress,
} from "../../../data/benchmark/mockData";
import { LeaderboardPage } from "../LeaderboardPage";

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

function firstStrategyRow(): HTMLElement {
  const table = screen.getByRole("table");
  return within(table).getAllByRole("link")[0]!;
}

describe("LeaderboardPage", () => {
  it("renders the hero, status strip and one strategy row per strategy", () => {
    renderLeaderboard();

    expect(screen.getByRole("heading", { name: "Connections Lab" })).toBeInTheDocument();
    expect(screen.getByText("Benchmark how puzzle-solving strategies compare across every ingested puzzle.")).toBeInTheDocument();

    const strategies = getStrategyAggregates();
    expect(within(screen.getByRole("table")).getAllByRole("link").length).toBe(strategies.length);
    expect(screen.getByText("Alphabetical")).toBeInTheDocument();
  });

  it("summarizes in-flight work in the status strip", () => {
    renderLeaderboard();

    const { active, queued } = summarizeProgress(getStrategyAggregates());
    expect(screen.getByText(`${active} running`)).toBeInTheDocument();
    expect(screen.getByText(`${queued} queued`)).toBeInTheDocument();
  });

  it("marks the top-ranked strategy per the default metric as leading", () => {
    renderLeaderboard();

    const expected = sortStrategiesByMetric(getStrategyAggregates(), "avgGuesses")[0]!.name;
    expect(firstStrategyRow()).toHaveClass("bench-row--leading");
    expect(firstStrategyRow().textContent).toContain(expected);
  });

  it("re-ranks the leading row when the metric changes", async () => {
    const user = userEvent.setup();
    renderLeaderboard();

    await user.click(screen.getByRole("button", { name: "Success rate" }));

    const expected = sortStrategiesByMetric(getStrategyAggregates(), "successRate")[0]!.name;
    expect(firstStrategyRow()).toHaveClass("bench-row--leading");
    expect(firstStrategyRow().textContent).toContain(expected);
  });

  it("navigates to the strategy detail page on row click", async () => {
    const user = userEvent.setup();
    renderLeaderboard();

    await user.click(firstStrategyRow());

    expect(screen.getByText("strategy-details")).toBeInTheDocument();
  });

  it("leaves a clearly marked stub for the coverage calendar", () => {
    renderLeaderboard();

    expect(screen.getByRole("region", { name: "Puzzle coverage calendar" })).toBeInTheDocument();
    expect(screen.getByText(/calendar will be built here next/)).toBeInTheDocument();
  });
});
