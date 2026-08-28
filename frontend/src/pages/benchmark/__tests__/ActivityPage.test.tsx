import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FreeTierUsage,
  Leaderboard,
  LeaderboardRow,
  RecentRun,
} from "../../../data/benchmark/types";
import { ActivityPage } from "../ActivityPage";

const flagshipUsage: FreeTierUsage = {
  tier: "flagship",
  label: "Flagship models",
  usedTokens: 12_000,
  dailyLimitTokens: 250_000,
  remainingTokens: 238_000,
  models: ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"],
};

const miniUsage: FreeTierUsage = {
  tier: "mini",
  label: "Mini & nano models",
  usedTokens: 500_000,
  dailyLimitTokens: 2_500_000,
  remainingTokens: 2_000_000,
  models: [
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5-mini",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o-mini",
    "o3-mini",
    "o4-mini",
    "gpt-5-nano",
  ],
};

function makeRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    id: "alphabetical",
    strategyName: "alphabetical",
    modelName: null,
    kind: "deterministic",
    puzzlesCovered: 10,
    totalPuzzles: 12,
    progress: { completed: 10, active: 0, failed: 0, queued: 0 },
    successRate: 100,
    avgGuessesToSolve: 12,
    minGuesses: 4,
    maxGuesses: 40,
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

function makeRun(overrides: Partial<RecentRun> = {}): RecentRun {
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
    ...overrides,
  };
}

function stubFetch({
  leaderboard = emptyLeaderboard,
  recentRuns = [],
}: {
  leaderboard?: Leaderboard;
  recentRuns?: RecentRun[];
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/strategy/free-tier-usage/flagship")) {
        return Promise.resolve({ ok: true, json: async () => flagshipUsage });
      }
      if (href.includes("/strategy/free-tier-usage/mini")) {
        return Promise.resolve({ ok: true, json: async () => miniUsage });
      }
      if (href.includes("/strategy/runs/recent")) {
        return Promise.resolve({ ok: true, json: async () => recentRuns });
      }
      return Promise.resolve({ ok: true, json: async () => leaderboard });
    }),
  );
}

function renderActivity() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/activity"]}>
        <Routes>
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/leaderboard/:strategyId/:puzzleId" element={<div>run-page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ActivityPage", () => {
  it("renders both free-tier budget widgets", async () => {
    stubFetch();
    renderActivity();

    expect(await screen.findByText("12,000 / 250,000 used")).toBeInTheDocument();
    expect(screen.getByText("238,000 tokens remaining today")).toBeInTheDocument();
    expect(screen.getByText("500,000 / 2,500,000 used")).toBeInTheDocument();
    expect(screen.getByText("2,000,000 tokens remaining today")).toBeInTheDocument();
    expect(screen.getByText("Flagship daily tokens")).toBeInTheDocument();
    expect(screen.getByText("Mini & nano daily tokens")).toBeInTheDocument();
  });

  it("shows each free-tier widget's total spend, summed from that tier's models across the whole leaderboard", async () => {
    stubFetch({
      leaderboard: {
        deterministic: [],
        llm: [
          makeRow({ id: "gpt-5", strategyName: "llm-openai", modelName: "gpt-5", kind: "llm", totalCostUsd: 1.5 }),
          makeRow({ id: "o1", strategyName: "llm-openai", modelName: "o1", kind: "llm", totalCostUsd: 2.25 }),
          makeRow({
            id: "o4-mini",
            strategyName: "llm-openai",
            modelName: "o4-mini",
            kind: "llm",
            totalCostUsd: 0.4,
          }),
          // Not in either tier's model list — must not be counted toward
          // either widget's total.
          makeRow({
            id: "mistral",
            strategyName: "llm-ollama",
            modelName: "mistral",
            kind: "llm",
            totalCostUsd: 99,
          }),
          // No runs priced yet — must not blow up the sum.
          makeRow({
            id: "o3",
            strategyName: "llm-openai",
            modelName: "o3",
            kind: "llm",
            totalCostUsd: null,
          }),
        ],
      },
    });
    renderActivity();

    expect(await screen.findByText("$3.75")).toBeInTheDocument(); // flagship: 1.5 + 2.25 + 0
    expect(screen.getByText("$0.40")).toBeInTheDocument(); // mini: 0.4
    expect(screen.getAllByText("spent on trials so far")).toHaveLength(2);
  });

  it("renders the Activity page heading", async () => {
    stubFetch();
    renderActivity();

    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
  });

  it("opens and closes the Enable Auto-Dispatch modal", async () => {
    const user = userEvent.setup();
    stubFetch();
    renderActivity();

    await user.click(await screen.findByRole("button", { name: "Enable Auto-Dispatch" }));
    expect(
      await screen.findByRole("heading", { name: "Enable Auto-Dispatch" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Enable Auto-Dispatch" })).not.toBeInTheDocument();
  });

  it("renders the recent-runs table with model, puzzle, and status per row", async () => {
    stubFetch({
      recentRuns: [
        makeRun({
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano-2025-04-14",
          puzzleDate: "2024-01-01",
          status: "completed",
          startedAt: "2024-01-01T08:15:00Z",
        }),
        makeRun({
          id: 2,
          strategyName: "shuffle-foolish",
          modelName: null,
          puzzleDate: "2024-01-02",
          status: "running",
          startedAt: "2024-01-02T20:45:00Z",
        }),
      ],
    });
    renderActivity();

    const table = await screen.findByRole("table", { name: /recent runs/i });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual(["Model", "Puzzle", "Started", "Status"]);

    const rows = within(table).getAllByRole("link");
    expect(rows[0]!.textContent).toContain("gpt-4.1-nano-2025-04-14");
    expect(rows[0]!.textContent).toContain("Jan 1, 2024");
    expect(rows[0]!.textContent).toContain("8:15 AM");
    expect(rows[0]!.textContent).toContain("Completed");
    // Deterministic/shuffle rows have no modelName — falls back to the
    // humanized strategy name.
    expect(rows[1]!.textContent).toContain("Shuffle-Foolish");
    expect(rows[1]!.textContent).toContain("Jan 2, 2024");
    expect(rows[1]!.textContent).toContain("8:45 PM");
    expect(rows[1]!.textContent).toContain("Running");
  });

  it("navigates to the run's puzzle page on click, keyed by model for LLM rows and strategy otherwise", async () => {
    const user = userEvent.setup();
    stubFetch({
      recentRuns: [
        makeRun({
          id: 1,
          puzzleId: 42,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano-2025-04-14",
        }),
      ],
    });
    renderActivity();

    const table = await screen.findByRole("table", { name: /recent runs/i });
    await user.click(within(table).getAllByRole("link")[0]!);

    expect(await screen.findByText("run-page")).toBeInTheDocument();
  });

  it("shows an empty state when there are no recent runs", async () => {
    stubFetch({ recentRuns: [] });
    renderActivity();

    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
  });

  it("polls the recent-runs endpoint on an interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/strategy/free-tier-usage/")) {
        return Promise.resolve({ ok: true, json: async () => flagshipUsage });
      }
      if (href.includes("/strategy/runs/recent")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => emptyLeaderboard });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderActivity();
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("runs/recent"))).toHaveLength(
        1,
      ),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("runs/recent"))).toHaveLength(
        2,
      ),
    );

    vi.useRealTimers();
  });
});
