import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PuzzleRunsPage } from "../PuzzleRunsPage";
import type { StrategyRunListItem, SupportedModelRecord } from "../../../data/benchmark/types";

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
  {
    ok = true,
    date,
    models = [],
  }: { ok?: boolean; date?: string; models?: SupportedModelRecord[] } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/strategy/models")) {
        return Promise.resolve({ ok: true, json: async () => models });
      }
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
  it("shows a not-found state for a strategyId absent from both the mock catalog and the real model allowlist", async () => {
    stubFetch([], { models: [] });

    renderRuns("/leaderboard/nope/1");

    // While the real allowlist check is in flight, the page doesn't jump
    // straight to "Unknown strategy" — it waits to be sure.
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    expect(await screen.findByText("Unknown strategy.")).toBeInTheDocument();
    // No match was found, so there's no strategyName to fetch runs for.
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/strategy/models"),
      expect.anything(),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/puzzle-id/1"),
      expect.anything(),
    );
  });

  it("resolves a strategyId the mock catalog doesn't know via the real model allowlist", async () => {
    const runs: StrategyRunListItem[] = [
      {
        id: 701,
        strategyName: "llm-openai",
        trialNumber: 1,
        status: "completed",
        modelName: "gpt-5-nano",
        contextWindow: null,
        startedAt: "2025-01-01T00:00:00Z",
        finishedAt: "2025-01-01T00:00:02Z",
        guessCount: 3,
      },
    ];
    stubFetch(runs, {
      models: [
        {
          id: 2,
          strategyName: "llm-openai",
          modelName: "gpt-5-nano",
          inputCostPerMillionTokens: 0.05,
          outputCostPerMillionTokens: 0.4,
          supported: true,
          contextWindow: null,
          paramCount: null,
          providerDescription: null,
          releaseDate: null,
        },
      ],
    });

    renderRuns("/leaderboard/gpt-5-nano/1");

    expect(await screen.findByRole("heading", { name: "LLM · gpt-5-nano" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Guess chain" })).toBeInTheDocument();
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

  it("refetches the run list after a run is deleted, so the deleted run drops out of view", async () => {
    const user = userEvent.setup();
    const errorRun: StrategyRunListItem[] = [{ ...singleRun[0]!, status: "error" }];
    let runsCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        const href = String(url);
        if (init?.method === "DELETE") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              message: "Deleted strategy run 501 and all related data",
              runId: 501,
              deletedGuesses: 0,
              deletedSolvePrompts: 0,
              deletedLlmProposals: 0,
            }),
          });
        }
        if (href.includes("/strategy/") && href.includes("/puzzle-id/")) {
          runsCallCount += 1;
          return Promise.resolve({ ok: true, json: async () => (runsCallCount === 1 ? errorRun : []) });
        }
        // /strategy/run/:runId
        const runId = Number(href.match(/\/run\/(\d+)/)?.[1]);
        return Promise.resolve({ ok: true, json: async () => ({ ...runDetailFor(runId), status: "error" }) });
      }),
    );

    renderRuns("/leaderboard/alphabetical/1");

    await user.click(await screen.findByRole("button", { name: "Delete this run" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/hasn't been run for this puzzle yet/)).toBeInTheDocument();
    expect(runsCallCount).toBe(2);
  });
});
