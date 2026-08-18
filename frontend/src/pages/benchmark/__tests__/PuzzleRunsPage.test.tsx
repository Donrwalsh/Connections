import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PuzzleRunsPage } from "../PuzzleRunsPage";
import type { StrategyRunListItem } from "../../../data/benchmark/types";

const singleRun: StrategyRunListItem[] = [
  {
    id: 501,
    strategyName: "alphabetical",
    trialNumber: 0,
    status: "completed",
    modelName: null,
    contextWindow: null,
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:02Z",
    guessCount: 4,
  },
];

// The route's strategyId for an "llm" kind mock row is a model name (see
// mockData.ts's STRATEGY_DEFS / StrategyMeta) — PuzzleRunsPage resolves it to
// the underlying backend strategyName ("llm-openai") for the fetch, then
// filters the response down to runs whose modelName matches this row's id.
const LLM_MODEL_ID = "gpt-4.1-nano-2025-04-14";

const multiRun: StrategyRunListItem[] = [
  {
    id: 601,
    strategyName: "llm-openai",
    trialNumber: 1,
    status: "completed",
    modelName: LLM_MODEL_ID,
    contextWindow: 128_000,
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:05Z",
    guessCount: 4,
  },
  {
    id: 602,
    strategyName: "llm-openai",
    trialNumber: 2,
    status: "failed",
    modelName: LLM_MODEL_ID,
    contextWindow: 128_000,
    startedAt: "2025-01-01T00:01:00Z",
    finishedAt: "2025-01-01T00:01:08Z",
    guessCount: 6,
  },
];

function runDetailFor(id: number) {
  return {
    id,
    strategyName: "alphabetical",
    trialNumber: 0,
    status: "completed",
    modelName: null,
    contextWindow: null,
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:02Z",
    guessCount: 0,
    guesses: [],
    solvePrompts: [],
    meta: { total: 0, page: 1, limit: 200 },
  };
}

function stubFetch(
  runs: StrategyRunListItem[] | null,
  { ok = true, date }: { ok?: boolean; date?: string } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/game/puzzle-id/")) {
        if (date === undefined) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ message: "no date" }),
          });
        }
        const id = Number(href.match(/\/puzzle-id\/(\d+)/)?.[1]);
        return Promise.resolve({ ok: true, json: async () => ({ id, date }) });
      }
      if (href.includes("/strategy/") && href.includes("/puzzle-id/")) {
        if (!ok) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ message: "boom" }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => runs ?? [] });
      }
      // /strategy/run/:runId
      const runId = Number(href.match(/\/run\/(\d+)/)?.[1]);
      return Promise.resolve({ ok: true, json: async () => runDetailFor(runId) });
    }),
  );
}

function renderRuns(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/leaderboard/:strategyId/:puzzleId" element={<PuzzleRunsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PuzzleRunsPage", () => {
  it("shows a not-found state for an unknown strategy, without fetching", () => {
    stubFetch([]);

    renderRuns("/leaderboard/nope/1");

    expect(screen.getByText("Unknown strategy.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a not-found state for a non-numeric puzzle id", () => {
    stubFetch([]);

    renderRuns("/leaderboard/alphabetical/not-a-number");

    expect(screen.getByText("Unknown puzzle.")).toBeInTheDocument();
  });

  it("shows a loading state while the runs list is in flight", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    renderRuns("/leaderboard/alphabetical/1");

    expect(screen.getByText("Loading runs…")).toBeInTheDocument();
  });

  it("shows an empty state when the strategy hasn't been run for this puzzle yet", async () => {
    stubFetch([]);

    renderRuns("/leaderboard/alphabetical/1");

    expect(await screen.findByText(/hasn't been run for this puzzle yet/)).toBeInTheDocument();
  });

  it("shows an error message when the runs fetch fails", async () => {
    stubFetch(null, { ok: false });

    renderRuns("/leaderboard/alphabetical/1");

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("skips the run picker and renders the visualizer directly for a single fetched run", async () => {
    stubFetch(singleRun);

    renderRuns("/leaderboard/alphabetical/1");

    expect(await screen.findByRole("heading", { name: "Guess chain" })).toBeInTheDocument();
    expect(screen.getByText("#501")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("lists every fetched run and visualizes the first one by default", async () => {
    stubFetch(multiRun);

    renderRuns(`/leaderboard/${LLM_MODEL_ID}/1`);

    const table = await screen.findByRole("table");
    const runRows = within(table).getAllByRole("button");
    expect(runRows.length).toBe(multiRun.length);
    expect(screen.getByText("#601")).toBeInTheDocument();
  });

  it("switches the visualized run when another run is selected", async () => {
    const user = userEvent.setup();
    stubFetch(multiRun);

    renderRuns(`/leaderboard/${LLM_MODEL_ID}/1`);

    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /#2/ }));

    expect(await screen.findByText("#602")).toBeInTheDocument();
    expect(screen.queryByText("#601")).not.toBeInTheDocument();
  });

  it("shows the derived puzzle status once runs are loaded", async () => {
    stubFetch(multiRun);

    const { container } = render(
      <MemoryRouter initialEntries={[`/leaderboard/${LLM_MODEL_ID}/1`]}>
        <Routes>
          <Route path="/leaderboard/:strategyId/:puzzleId" element={<PuzzleRunsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("table");
    // Not every run completed (one failed), so the puzzle-level badge reads Failed.
    const badges = container.querySelector(".bench-page-header .bench-badges");
    expect(badges).not.toBeNull();
    expect(within(badges as HTMLElement).getByText("Failed")).toBeInTheDocument();
  });

  it("prominently displays the model as the page title", async () => {
    stubFetch(multiRun, { date: "2023-06-12" });

    renderRuns(`/leaderboard/${LLM_MODEL_ID}/1`);

    expect(await screen.findByRole("heading", { name: `LLM · ${LLM_MODEL_ID}` })).toBeInTheDocument();
  });

  it("shows the puzzle's date once it loads, and links to the puzzle page for it", async () => {
    stubFetch(singleRun, { date: "2023-06-12" });

    renderRuns("/leaderboard/alphabetical/1");

    const puzzleLink = await screen.findByRole("link", { name: /view puzzle/i });
    expect(puzzleLink).toHaveAttribute("href", "/puzzle/2023-06-12");
    expect(screen.getByText("Jun 12, 2023")).toBeInTheDocument();
  });

  it("still renders the page normally when the puzzle date fails to load", async () => {
    stubFetch(singleRun);

    renderRuns("/leaderboard/alphabetical/1");

    expect(await screen.findByRole("heading", { name: "Alphabetical" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view puzzle/i })).not.toBeInTheDocument();
  });

  it("keeps the back-navigation link and the puzzle link both present and distinct", async () => {
    stubFetch(singleRun, { date: "2023-06-12" });

    renderRuns("/leaderboard/alphabetical/1");

    const backLink = await screen.findByRole("link", { name: /← Alphabetical/ });
    const puzzleLink = screen.getByRole("link", { name: /view puzzle/i });
    expect(backLink).toHaveAttribute("href", "/leaderboard/alphabetical");
    expect(puzzleLink).toHaveAttribute("href", "/puzzle/2023-06-12");
  });
});
