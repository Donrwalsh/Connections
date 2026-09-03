import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { RunHistoryRow } from "../../../data/benchmark/types";
import { formatDuration } from "../../../data/benchmark/metrics";
import { RunHistoryTable } from "../RunHistoryTable";

function makeRow(overrides: Partial<RunHistoryRow> = {}): RunHistoryRow {
  return {
    id: 1,
    puzzleId: 10,
    puzzleDate: "2024-01-01",
    strategyName: "llm-openai",
    modelName: "gpt-4.1-nano",
    trialNumber: 0,
    status: "completed",
    startedAt: "2024-01-01T00:00:00Z",
    finishedAt: "2024-01-01T00:00:05Z",
    solveDurationMs: null,
    guessCount: 4,
    tokenCostUsd: null,
    issueCount: 0,
    categoryCorrect: 0,
    categoryPartial: 0,
    categoryLucky: 0,
    ...overrides,
  };
}

function renderTable(rows: RunHistoryRow[]) {
  render(
    <MemoryRouter>
      <RunHistoryTable
        strategyId="gpt-4.1-nano"
        rows={rows}
        sortBy="puzzleDate"
        sortDir="desc"
        onSortChange={vi.fn()}
        showTokenCost={false}
        status={null}
        onStatusChange={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("RunHistoryTable", () => {
  it("shows solveDurationMs formatted, and a dash when it is null", () => {
    renderTable([
      makeRow({
        id: 1,
        solveDurationMs: 6000,
        // 3-hour wall-clock span — must NOT be what the cell shows.
        startedAt: "2024-01-01T00:00:00Z",
        finishedAt: "2024-01-01T03:00:00Z",
      }),
      makeRow({ id: 2, solveDurationMs: null }),
    ]);

    expect(screen.getByText(formatDuration(6000))).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
