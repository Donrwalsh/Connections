import type { ReactElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { LeaderboardRow } from "../../../data/benchmark/types";
import { StrategyTable } from "../StrategyTable";

function makeRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    id: "alphabetical",
    strategyName: "alphabetical",
    modelName: null,
    kind: "deterministic",
    puzzlesCovered: 10,
    totalPuzzles: 12,
    progress: { completed: 10, active: 0, failed: 0, queued: 0 },
    successRate: 80,
    avgGuessesToSolve: 4,
    minGuesses: 4,
    maxGuesses: 8,
    avgDurationMs: 12,
    avgCostUsd: null,
    totalCostUsd: null,
    avgIssues: 1.5,
    categoryCorrect: 6,
    categoryPartial: 2,
    categoryLucky: 2,
    categoryEvaluated: 10,
    categoryAccuracy: 60,
    contextWindow: null,
    paramCount: null,
    providerDescription: null,
    ...overrides,
  };
}

function renderTable(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("StrategyTable — Category IQ column", () => {
  it("renders a Category IQ header and a formatted percent cell on the LLM table", () => {
    renderTable(
      <StrategyTable
        rows={[
          makeRow({
            id: "gpt-4.1-nano-2025-04-14",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            kind: "llm",
            categoryAccuracy: 60,
          }),
        ]}
        metricKey="successRate"
        variant="llm"
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Category IQ" })).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("renders an em dash when nothing has been evaluated yet", () => {
    renderTable(
      <StrategyTable
        rows={[
          makeRow({
            id: "gpt-4.1-nano-2025-04-14",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            kind: "llm",
            categoryCorrect: 0,
            categoryPartial: 0,
            categoryLucky: 0,
            categoryEvaluated: 0,
            categoryAccuracy: null,
          }),
        ]}
        metricKey="successRate"
        variant="llm"
      />,
    );

    const row = screen.getByRole("link");
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("does not render a Category IQ header on the deterministic table", () => {
    renderTable(
      <StrategyTable
        rows={[makeRow()]}
        metricKey="successRate"
        variant="deterministic"
      />,
    );

    expect(
      screen.queryByRole("columnheader", { name: "Category IQ" }),
    ).not.toBeInTheDocument();
  });
});
