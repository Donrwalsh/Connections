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
    issueCount: 0,
    categoryCorrect: 0,
    categoryPartial: 0,
    categoryLucky: 0,
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
    avgIssues: null,
    categoryCorrect: 0,
    categoryPartial: 0,
    categoryLucky: 0,
    categoryEvaluated: 0,
    categoryAccuracy: null,
    contextWindow: null,
    paramCount: null,
    providerDescription: null,
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

  it("shows the Category IQ breakdown for an LLM row with evaluated categories", async () => {
    stubFetch({
      leaderboard: {
        deterministic: [],
        llm: [
          makeLeaderboardRow({
            id: "gpt-4.1-nano-2025-04-14",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            kind: "llm",
            categoryCorrect: 6,
            categoryPartial: 2,
            categoryLucky: 2,
            categoryEvaluated: 10,
            categoryAccuracy: 60,
          }),
        ],
      },
      history: {
        rows: [makeRow({ strategyName: "llm-openai", modelName: "gpt-4.1-nano-2025-04-14" })],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    renderStrategy("gpt-4.1-nano-2025-04-14");

    expect(await screen.findByText("Category IQ")).toBeInTheDocument();
    const item = screen.getByText("Category IQ").closest(".bench-summary__item");
    expect(within(item as HTMLElement).getByText("60%")).toBeInTheDocument();
    expect(within(item as HTMLElement).getByText(/6 correct · 2 partial · 2 lucky/)).toBeInTheDocument();
  });

  it("shows 'not yet evaluated' for Category IQ when nothing has been judged", async () => {
    stubFetch({
      leaderboard: {
        deterministic: [],
        llm: [
          makeLeaderboardRow({
            id: "gpt-4.1-nano-2025-04-14",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            kind: "llm",
            categoryEvaluated: 0,
            categoryAccuracy: null,
          }),
        ],
      },
      history: {
        rows: [makeRow({ strategyName: "llm-openai", modelName: "gpt-4.1-nano-2025-04-14" })],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    renderStrategy("gpt-4.1-nano-2025-04-14");

    expect(await screen.findByText("Category IQ")).toBeInTheDocument();
    const item = screen.getByText("Category IQ").closest(".bench-summary__item");
    expect(within(item as HTMLElement).getByText("not yet evaluated")).toBeInTheDocument();
    expect(within(item as HTMLElement).queryByText(/correct ·/)).not.toBeInTheDocument();
  });

  it("omits the Category IQ item entirely for a deterministic strategy", async () => {
    stubFetch({
      leaderboard: { deterministic: [makeLeaderboardRow()], llm: [] },
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    await screen.findByText("100%");
    expect(screen.queryByText("Category IQ")).not.toBeInTheDocument();
    expect(screen.queryByText("not yet evaluated")).not.toBeInTheDocument();
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
    const headerCells = within(table).getAllByRole("columnheader");
    expect(headerCells.slice(0, -1).map((header) => header.textContent)).toEqual([
      "Puzzle date ↓",
      "Run date",
      "Guesses",
      "Duration",
    ]);
    // The last (Status) header holds the status filter — see
    // RunStatusFilter — rather than a plain "Status" label.
    expect(within(headerCells[headerCells.length - 1]!).getByLabelText("Status")).toBeInTheDocument();

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

  it("flags a run with issue-tagged prompts", async () => {
    stubFetch({
      history: {
        rows: [makeRow({ issueCount: 2 })],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    renderStrategy("alphabetical");

    expect(await screen.findByText("2 issues")).toBeInTheDocument();
  });

  it("does not render an issue badge for a run with no issues", async () => {
    stubFetch({
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    await screen.findByRole("table");
    expect(screen.queryByText(/issue/)).not.toBeInTheDocument();
  });

  it("shows a verdict square per non-zero category-judge count on a judged run", async () => {
    stubFetch({
      history: {
        rows: [
          makeRow({
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            categoryCorrect: 3,
            categoryPartial: 1,
            categoryLucky: 0,
          }),
        ],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    renderStrategy("gpt-4.1-nano-2025-04-14");

    expect(await screen.findByTitle("3 correct — judge matched the real connection")).toHaveTextContent(
      "3",
    );
    expect(
      screen.getByTitle("1 partial — judge only partly matched the connection"),
    ).toHaveTextContent("1");
    // lucky count is 0 — no square for it.
    expect(screen.queryByTitle(/lucky/)).not.toBeInTheDocument();
  });

  it("renders no verdict squares for a run with no category evaluations", async () => {
    stubFetch({
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    await screen.findByRole("table");
    expect(screen.queryByRole("group", { name: "Category-judge verdicts" })).not.toBeInTheDocument();
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
    const headerCells = within(table).getAllByRole("columnheader");
    expect(headerCells.slice(0, -1).map((header) => header.textContent)).toEqual([
      "Puzzle date ↓",
      "Run date",
      "Guesses",
      "Duration",
      "Token cost",
    ]);
    expect(within(headerCells[headerCells.length - 1]!).getByLabelText("Status")).toBeInTheDocument();
    expect(within(table).getByText("$0.12")).toBeInTheDocument();
  });

  it("sorts by Token cost when its column header is clicked, resetting to page 1", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      history: {
        rows: [makeRow({ strategyName: "llm-openai", modelName: "gpt-4.1-nano-2025-04-14" })],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    renderStrategy("gpt-4.1-nano-2025-04-14");

    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /Sort by Token cost/ }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("sortBy=tokenCost"),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("sortDir=desc"), expect.anything());
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("page=1"), expect.anything());
  });

  it("filters by status when the status dropdown changes, resetting to page 1", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    await screen.findByRole("table");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("status=failed"),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("page=1"), expect.anything());

    // Switching back to the unset "Status" option drops the param entirely
    // rather than sending an empty one.
    await user.selectOptions(screen.getByLabelText("Status"), "");
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.not.stringContaining("status="),
      expect.anything(),
    );
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

  it("shows the provider's own description below the stats line for an LLM model", async () => {
    stubFetch({
      leaderboard: {
        deterministic: [],
        llm: [
          makeLeaderboardRow({
            id: "gpt-4.1-nano-2025-04-14",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            kind: "llm",
            providerDescription: "For tasks that demand low latency, GPT-4.1 nano is the fastest.",
          }),
        ],
      },
    });

    renderStrategy("gpt-4.1-nano-2025-04-14");

    expect(
      await screen.findByText(
        "For tasks that demand low latency, GPT-4.1 nano is the fastest.",
      ),
    ).toBeInTheDocument();
  });

  it("shows no provider-description paragraph for a deterministic strategy", async () => {
    stubFetch({
      leaderboard: { deterministic: [makeLeaderboardRow()], llm: [] },
    });

    renderStrategy("alphabetical");

    await screen.findByRole("heading", { name: "Alphabetical" });
    expect(
      screen.queryByText("For tasks that demand low latency, GPT-4.1 nano is the fastest."),
    ).not.toBeInTheDocument();
  });

  it("shows no provider-description paragraph for an LLM model with no description yet", async () => {
    stubFetch({
      leaderboard: {
        deterministic: [],
        llm: [
          makeLeaderboardRow({
            id: "gpt-4.1-nano-2025-04-14",
            strategyName: "llm-openai",
            modelName: "gpt-4.1-nano-2025-04-14",
            kind: "llm",
            providerDescription: null,
          }),
        ],
      },
    });

    renderStrategy("gpt-4.1-nano-2025-04-14");

    await screen.findByRole("heading", { name: "LLM · gpt-4.1-nano-2025-04-14" });
    expect(screen.queryByText(/^For tasks/)).not.toBeInTheDocument();
  });
});
