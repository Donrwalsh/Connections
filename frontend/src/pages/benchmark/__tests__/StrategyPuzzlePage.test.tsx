import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Leaderboard, LeaderboardRow, RunHistory, RunHistoryRow } from "../../../data/benchmark/types";
import { StrategyPuzzlePage } from "../StrategyPuzzlePage";

function makeRow(overrides: Partial<RunHistoryRow> = {}): RunHistoryRow {
  return {
    id: 1,
    puzzleId: 10,
    puzzleDate: "2024-01-01",
    strategyName: "alphabetical",
    modelName: null,
    trialNumber: 0,
    status: "completed",
    startedAt: "2024-01-01T00:00:00Z",
    finishedAt: "2024-01-01T00:00:05Z",
    guessCount: 4,
    tokenCostUsd: null,
    ...overrides,
  };
}

function makeLeaderboardRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    id: "alphabetical",
    strategyName: "alphabetical",
    modelName: null,
    kind: "deterministic",
    puzzlesCovered: 100,
    totalPuzzles: 1174,
    progress: { completed: 100, active: 0, failed: 0, queued: 0 },
    successRate: 100,
    avgGuessesToSolve: 4,
    minGuesses: 4,
    maxGuesses: 8,
    avgDurationMs: 12,
    avgCostUsd: null,
    totalCostUsd: null,
    ...overrides,
  };
}

const emptyLeaderboard: Leaderboard = { deterministic: [], llm: [] };
const emptyHistory: RunHistory = { rows: [], meta: { total: 0, page: 1, limit: 100 } };

function stubFetch({
  leaderboard = emptyLeaderboard,
  history = emptyHistory,
  historyOk = true,
}: {
  leaderboard?: Leaderboard;
  history?: RunHistory | ((href: string) => RunHistory);
  historyOk?: boolean;
} = {}) {
  const fetchMock = vi.fn((url: unknown) => {
    const href = String(url);
    if (href.includes("/strategy/leaderboard")) {
      return Promise.resolve({ ok: true, json: async () => leaderboard });
    }
    if (href.includes("/strategy/models")) {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (href.includes("/runs")) {
      if (!historyOk) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ message: "boom" }) });
      }
      const data = typeof history === "function" ? history(href) : history;
      return Promise.resolve({ ok: true, json: async () => data });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderStrategy(strategyId = "alphabetical") {
  render(
    <MemoryRouter initialEntries={[`/leaderboard/${strategyId}`]}>
      <Routes>
        <Route path="/leaderboard/:strategyId" element={<StrategyPuzzlePage />} />
        <Route path="/leaderboard/:strategyId/:puzzleId" element={<div>runs-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StrategyPuzzlePage", () => {
  it("renders the strategy header with summary stats from the leaderboard", async () => {
    stubFetch({
      leaderboard: { deterministic: [makeLeaderboardRow()], llm: [] },
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    expect(await screen.findByRole("heading", { name: "Alphabetical" })).toBeInTheDocument();
    expect(screen.getByText("Deterministic · tries words in alphabetical order")).toBeInTheDocument();
    expect(await screen.findByText("100%")).toBeInTheDocument();

    const puzzlesItem = screen.getByText("Puzzles").closest(".bench-summary__item");
    expect(puzzlesItem?.textContent).toContain("100 / 1,174");

    // Deterministic row: avgCostUsd/totalCostUsd are null (no LLM cost
    // concept), so both items show "—" rather than being hidden — the
    // summary bar's item set stays consistent across every strategy kind.
    const avgCostItem = screen.getByText("Avg cost").closest(".bench-summary__item");
    expect(avgCostItem?.textContent).toBe("Avg cost—");
    const totalCostItem = screen.getByText("Total cost").closest(".bench-summary__item");
    expect(totalCostItem?.textContent).toBe("Total cost—");
  });

  it("formats summary numbers over 999 with thousands separators", async () => {
    stubFetch({
      leaderboard: {
        deterministic: [
          makeLeaderboardRow({
            puzzlesCovered: 1174,
            totalPuzzles: 1174,
            avgGuessesToSolve: 1325.4,
            progress: { completed: 1174, active: 0, failed: 0, queued: 1500 },
          }),
        ],
        llm: [],
      },
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    await screen.findByText("100%");
    const puzzlesItem = screen.getByText("Puzzles").closest(".bench-summary__item");
    expect(puzzlesItem?.textContent).toBe("Puzzles1,174 / 1,174");
    const guessesItem = screen.getByText("Avg guesses").closest(".bench-summary__item");
    expect(guessesItem?.textContent).toBe("Avg guesses1,325.4");
    expect(screen.getByText("Queued 1,500")).toBeInTheDocument();
  });

  it("shows real Avg cost/Total cost values next to Success rate for an LLM row", async () => {
    stubFetch({
      leaderboard: {
        deterministic: [],
        llm: [
          makeLeaderboardRow({
            id: "gpt-4.1-nano-2025-04-14",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            kind: "llm",
            avgCostUsd: 0.1234,
            totalCostUsd: 0.4936,
          }),
        ],
      },
      history: {
        rows: [makeRow({ strategyName: "llm-openai", modelName: "gpt-4.1-nano-2025-04-14" })],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    const { container } = render(
      <MemoryRouter initialEntries={["/leaderboard/gpt-4.1-nano-2025-04-14"]}>
        <Routes>
          <Route path="/leaderboard/:strategyId" element={<StrategyPuzzlePage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("100%");
    const items = Array.from(container.querySelectorAll(".bench-summary__item")).map(
      (item) => item.textContent,
    );
    // Success rate is immediately followed by Avg cost then Total cost.
    expect(items.slice(0, 3)).toEqual(["Success rate100%", "Avg cost$0.12", "Total cost$0.49"]);
  });

  it("renders one row per run with each value under its own column, in header order", async () => {
    stubFetch({
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    const table = await screen.findByRole("table");
    // Cell order must track header order exactly — a value sitting under the
    // wrong header (e.g. guesses/duration transposed) wouldn't be caught by
    // just asserting presence anywhere in the table.
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual(["Puzzle date ↓", "Run date", "Guesses", "Duration", "Status"]);

    // The row itself carries an explicit role="link" (see RunHistoryTable),
    // which overrides its implicit "row" role — query its <td>s directly by
    // DOM position instead of by ARIA "cell" role.
    const dataRow = within(table).getAllByRole("link")[0]!;
    const cells = Array.from(dataRow.querySelectorAll("td")).map((cell) => cell.textContent);
    expect(cells[0]).toBe("Jan 1, 2024");
    expect(cells[2]).toBe("4");
    expect(cells[3]).toBe("5.0s");
    expect(cells[4]).toBe("Completed");
    expect(within(table).queryByRole("columnheader", { name: "Token cost" })).not.toBeInTheDocument();
  });

  it("shows the Token cost column for an LLM strategy, ordered before Status (the far-right column)", async () => {
    stubFetch({
      history: {
        rows: [
          makeRow({
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            tokenCostUsd: 0.1234,
          }),
        ],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    renderStrategy("gpt-4.1-nano-2025-04-14");

    const table = await screen.findByRole("table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual(["Puzzle date ↓", "Run date", "Guesses", "Duration", "Token cost", "Status"]);
    expect(within(table).getByText("$0.12")).toBeInTheDocument();
  });

  it("requests the next page and toggles the prev/next buttons", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      history: (href) => ({
        rows: [makeRow({ id: href.includes("page=2") ? 2 : 1 })],
        meta: { total: 150, page: 1, limit: 100 },
      }),
    });

    renderStrategy("alphabetical");

    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "← Prev" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next →" })).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next →" }));

    expect(await screen.findByText("Page 2 of 2 · 150 runs")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("page=2"), expect.anything());
  });

  it("re-sorts when a sortable column header is clicked, resetting to page 1", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /Sort by Guesses/ }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("sortBy=guessCount"),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("sortDir=desc"), expect.anything());
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("page=1"), expect.anything());
  });

  it("navigates to the puzzle's runs page when a run row is clicked", async () => {
    const user = userEvent.setup();
    stubFetch({
      history: { rows: [makeRow({ puzzleId: 42 })], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    const table = await screen.findByRole("table");
    await user.click(within(table).getAllByRole("link")[0]!);

    expect(screen.getByText("runs-page")).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown strategy", async () => {
    stubFetch();

    renderStrategy("does-not-exist");

    expect(await screen.findByText("Unknown strategy.")).toBeInTheDocument();
  });

  it("shows an error message when the run history fetch fails", async () => {
    stubFetch({ historyOk: false });

    renderStrategy("alphabetical");

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
