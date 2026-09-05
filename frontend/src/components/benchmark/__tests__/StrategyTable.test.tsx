import type { ReactElement } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
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

describe("StrategyTable — routing a model id containing a slash", () => {
  // Regression: Groq model ids ("qwen/qwen3.6-27b", "openai/gpt-oss-120b")
  // contain a literal "/", unlike every prior model id this route was built
  // around (see StrategyMeta's doc comment). An un-encoded link splits into
  // two path segments, which /leaderboard/:strategyId (one segment) can't
  // match — React Router logs "No routes matched" and never navigates.
  it("navigates to a correctly-encoded /leaderboard/:strategyId URL", async () => {
    function ParamProbe() {
      const { strategyId } = useParams();
      return <div data-testid="probe">{strategyId}</div>;
    }

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/from"]}>
        <Routes>
          <Route
            path="/from"
            element={
              <StrategyTable
                rows={[
                  makeRow({
                    id: "qwen/qwen3.6-27b",
                    strategyName: "llm-groq",
                    modelName: "qwen/qwen3.6-27b",
                    kind: "llm",
                  }),
                ]}
                metricKey="successRate"
                variant="llm"
              />
            }
          />
          <Route path="/leaderboard/:strategyId" element={<ParamProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link"));

    expect(await screen.findByTestId("probe")).toHaveTextContent("qwen/qwen3.6-27b");
  });
});
