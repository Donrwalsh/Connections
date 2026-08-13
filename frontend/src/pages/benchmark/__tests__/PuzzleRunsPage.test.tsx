import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { getPuzzleRuns } from "../../../data/benchmark/mockData";
import { PuzzleRunsPage } from "../PuzzleRunsPage";

function renderRuns(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/leaderboard/:strategyId/:puzzleId" element={<PuzzleRunsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PuzzleRunsPage", () => {
  it("skips the run picker and renders the visualizer directly for single-run strategies", () => {
    const runs = getPuzzleRuns("alphabetical", 1);

    renderRuns("/leaderboard/alphabetical/1");

    expect(screen.getByRole("heading", { name: "Guess chain" })).toBeInTheDocument();
    expect(screen.getByText(`#${runs[0]!.runId}`)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a not-found state for an unknown strategy", () => {
    renderRuns("/leaderboard/nope/1");

    expect(screen.getByText("Unknown strategy.")).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown puzzle", () => {
    renderRuns("/leaderboard/alphabetical/999");

    expect(screen.getByText("Unknown puzzle.")).toBeInTheDocument();
  });
});

describe("PuzzleRunsPage multi-run", () => {
  it("lists the runs and visualizes the first one by default", () => {
    const runs = getPuzzleRuns("llm-openai", 1);

    renderRuns("/leaderboard/llm-openai/1");

    const runRows = within(screen.getByRole("table")).getAllByRole("button");
    expect(runRows.length).toBe(runs.length);
    expect(screen.getByText(`#${runs[0]!.runId}`)).toBeInTheDocument();
  });

  it("switches the visualized run when another run is selected", async () => {
    const user = userEvent.setup();
    const runs = getPuzzleRuns("llm-openai", 1);
    const target = runs[1]!;

    renderRuns("/leaderboard/llm-openai/1");
    await user.click(screen.getByRole("button", { name: /#2/ }));

    expect(screen.getByText(`#${target.runId}`)).toBeInTheDocument();
    expect(screen.queryByText(`#${runs[0]!.runId}`)).not.toBeInTheDocument();
  });
});
