import type { ReactElement } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
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
        sortBy="successRate"
        sortDir="desc"
        onSortChange={vi.fn()}
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
        sortBy="successRate"
        sortDir="desc"
        onSortChange={vi.fn()}
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
        sortBy="avgGuesses"
        sortDir="asc"
        onSortChange={vi.fn()}
        variant="deterministic"
      />,
    );

    expect(
      screen.queryByRole("columnheader", { name: "Category IQ" }),
    ).not.toBeInTheDocument();
  });
});

describe("StrategyTable — header-click sorting", () => {
  it("shows an ascending/descending arrow only on the active column, and toggles onClick", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderTable(
      <StrategyTable
        rows={[makeRow()]}
        sortBy="avgGuesses"
        sortDir="asc"
        onSortChange={onSortChange}
        variant="deterministic"
      />,
    );

    const activeButton = screen.getByRole("button", { name: "Sort by Avg guesses, ascending" });
    expect(activeButton).toHaveTextContent("Avg guesses ↑");
    expect(screen.getByRole("button", { name: "Sort by Range" })).toHaveTextContent("Range");

    await user.click(screen.getByRole("button", { name: "Sort by Range" }));
    expect(onSortChange).toHaveBeenCalledWith("range");

    await user.click(activeButton);
    expect(onSortChange).toHaveBeenCalledWith("avgGuesses");
  });

  it("sorts rows by the given column and direction", () => {
    renderTable(
      <StrategyTable
        rows={[
          makeRow({ id: "a", strategyName: "a", avgGuessesToSolve: 30 }),
          makeRow({ id: "b", strategyName: "b", avgGuessesToSolve: 5 }),
        ]}
        sortBy="avgGuesses"
        sortDir="asc"
        onSortChange={vi.fn()}
        variant="deterministic"
      />,
    );

    const [first, second] = screen.getAllByRole("link");
    expect(first).toHaveTextContent("B");
    expect(second).toHaveTextContent("A");
  });

  it("sorts the Range column by its upper (max guesses) value", () => {
    renderTable(
      <StrategyTable
        rows={[
          makeRow({ id: "a", strategyName: "a", maxGuesses: 40 }),
          makeRow({ id: "b", strategyName: "b", maxGuesses: 8 }),
        ]}
        sortBy="range"
        sortDir="asc"
        onSortChange={vi.fn()}
        variant="deterministic"
      />,
    );

    const [first, second] = screen.getAllByRole("link");
    expect(first).toHaveTextContent("B");
    expect(second).toHaveTextContent("A");
  });

  it("sorts the Strategy column alphabetically by display name, not the raw strategyName", () => {
    // Both rows share the "llm-openai" strategyName — only their display
    // names (the model names) differ, so a correct alphabetical sort has to
    // read the name actually shown in the column, not the tied strategyName.
    renderTable(
      <StrategyTable
        rows={[
          makeRow({
            id: "gpt-5",
            strategyName: "llm-openai",
            modelName: "gpt-5",
            kind: "llm",
          }),
          makeRow({
            id: "gpt-4.1-nano",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano",
            kind: "llm",
          }),
        ]}
        sortBy="name"
        sortDir="asc"
        onSortChange={vi.fn()}
        variant="llm"
      />,
    );

    const [first, second] = screen.getAllByRole("link");
    expect(first).toHaveTextContent("gpt-4.1-nano");
    expect(second).toHaveTextContent("gpt-5");
  });

  it("sorts the Progress column by puzzles covered", () => {
    renderTable(
      <StrategyTable
        rows={[
          makeRow({ id: "a", strategyName: "a", puzzlesCovered: 2, totalPuzzles: 100 }),
          makeRow({ id: "b", strategyName: "b", puzzlesCovered: 90, totalPuzzles: 100 }),
        ]}
        sortBy="progress"
        sortDir="desc"
        onSortChange={vi.fn()}
        variant="deterministic"
      />,
    );

    const [first, second] = screen.getAllByRole("link");
    expect(first).toHaveTextContent("B");
    expect(second).toHaveTextContent("A");
  });
});

describe("StrategyTable — provider pool badge", () => {
  it("shows the serving pool on an LLM row, from its strategyName not its vendor prefix", () => {
    renderTable(
      <StrategyTable
        rows={[
          makeRow({
            id: "openai/gpt-oss-20b",
            strategyName: "llm-groq",
            modelName: "openai/gpt-oss-20b",
            kind: "llm",
          }),
        ]}
        sortBy="successRate"
        sortDir="desc"
        onSortChange={vi.fn()}
        variant="llm"
      />,
    );

    const row = screen.getByRole("link");
    expect(within(row).getByText("Groq")).toBeInTheDocument();
  });

  it("shows no pool badge on a deterministic row", () => {
    renderTable(
      <StrategyTable
        rows={[makeRow()]}
        sortBy="avgGuesses"
        sortDir="asc"
        onSortChange={vi.fn()}
        variant="deterministic"
      />,
    );

    const row = screen.getByRole("link");
    expect(within(row).queryByText("Groq")).not.toBeInTheDocument();
    expect(within(row).queryByText("OpenAI")).not.toBeInTheDocument();
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
                sortBy="successRate"
                sortDir="desc"
                onSortChange={vi.fn()}
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
