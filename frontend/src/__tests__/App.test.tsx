import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Category } from "../data/types";

function renderApp(initialEntries: string[]) {
  // Fresh, retry-disabled client per render — matches the app's own
  // QueryClientProvider setup in main.tsx without cross-test cache bleed.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const categories: Category[] = [
  {
    id: "cat-1",
    name: "WET WEATHER",
    difficulty: "yellow",
    words: ["HAIL", "RAIN", "SLEET", "SNOW"],
  },
  {
    id: "cat-2",
    name: "NBA TEAMS",
    difficulty: "green",
    words: ["BUCKS", "HEAT", "JAZZ", "NETS"],
  },
  {
    id: "cat-3",
    name: "KEYBOARD KEYS",
    difficulty: "blue",
    words: ["OPTION", "RETURN", "SHIFT", "TAB"],
  },
  {
    id: "cat-4",
    name: "PALINDROMES",
    difficulty: "purple",
    words: ["KAYAK", "LEVEL", "MOM", "RACECAR"],
  },
];

const puzzleResponse = {
  id: 1,
  date: "2024-01-15",
  categories,
  wordOrder: categories.flatMap((c) => c.words),
  isImagePuzzle: false,
};

const strategyRun = {
  strategyName: "alphabetical",
  status: "completed",
  startedAt: "2024-01-15T00:00:00Z",
  finishedAt: "2024-01-15T00:05:00Z",
  guessCount: 1,
};

function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/strategy/")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              ...strategyRun,
              strategyName: String(url).match(/\/strategy\/([^/]+)\//)?.[1],
            },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => puzzleResponse });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App Component", () => {
  it("renders today's puzzle on the index route", async () => {
    setupFetch();

    renderApp(["/"]);

    expect(await screen.findByText("Monday, January 15, 2024")).toBeInTheDocument();
    // The header (shared across every route via SiteLayout) links to the
    // Activity page.
    expect(screen.getByRole("link", { name: /Activity/ })).toHaveAttribute("href", "/activity");
  });

  it("renders the puzzle for a specific date route", async () => {
    setupFetch();

    renderApp(["/puzzle/2024-01-15"]);

    expect(await screen.findByText("Monday, January 15, 2024")).toBeInTheDocument();
  });
});

describe("App leaderboard routes", () => {
  it("renders the leaderboard homepage at /leaderboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        // The page's two FreeTierBudgetWidget instances (flagship + mini)
        // each fetch independently of the leaderboard — give both a
        // real-shaped response so neither crashes on a mismatched shape.
        // One stub covers both, since the two routes only differ by suffix
        // and the widget doesn't validate the response's tier against its
        // own prop.
        if (String(url).includes("/strategy/free-tier-usage/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              tier: "flagship",
              label: "Flagship models",
              usedTokens: 0,
              dailyLimitTokens: 250_000,
              remainingTokens: 250_000,
              models: [],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deterministic: [
              {
                id: "alphabetical",
                strategyName: "alphabetical",
                modelName: null,
                kind: "deterministic",
                puzzlesCovered: 1,
                totalPuzzles: 1,
                progress: { completed: 1, active: 0, failed: 0, queued: 0 },
                successRate: 100,
                avgGuessesToSolve: 4,
                minGuesses: 4,
                maxGuesses: 4,
                avgDurationMs: 10,
              },
            ],
            llm: [],
          }),
        });
      }),
    );

    renderApp(["/leaderboard"]);

    expect((await screen.findAllByText("Connections Lab")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("heading", { name: "Deterministic & Shuffle" })).toBeInTheDocument();
  });

  it("renders a strategy's puzzle list at /leaderboard/:strategyId", async () => {
    renderApp(["/leaderboard/alphabetical"]);

    // StrategyPuzzlePage is lazy-loaded (see App.tsx), so it's only present
    // after Suspense resolves the dynamic import — not synchronously.
    expect(await screen.findByRole("heading", { name: "Alphabetical" })).toBeInTheDocument();
  });

  it("renders the single-run visualizer at /leaderboard/:strategyId/:puzzleId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const href = String(url);
        if (href.includes("/puzzle-id/")) {
          return Promise.resolve({
            ok: true,
            json: async () => [
              {
                id: 501,
                strategyName: "alphabetical",
                trialNumber: 0,
                status: "completed",
                modelName: null,
                contextWindow: null,
                startedAt: "2024-01-15T00:00:00Z",
                finishedAt: "2024-01-15T00:00:02Z",
                guessCount: 4,
              },
            ],
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 501,
            strategyName: "alphabetical",
            trialNumber: 0,
            status: "completed",
            modelName: null,
            contextWindow: null,
            startedAt: "2024-01-15T00:00:00Z",
            finishedAt: "2024-01-15T00:00:02Z",
            guessCount: 0,
            guesses: [],
            solvePrompts: [],
            meta: { total: 0, page: 1, limit: 200 },
          }),
        });
      }),
    );

    renderApp(["/leaderboard/alphabetical/1"]);

    expect(await screen.findByRole("heading", { name: "Guess chain" })).toBeInTheDocument();
  });

  it("renders the free-tier budget widgets at /activity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const href = String(url);
        if (href.includes("/strategy/free-tier-usage/flagship")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              tier: "flagship",
              label: "Flagship models",
              usedTokens: 0,
              dailyLimitTokens: 250_000,
              remainingTokens: 250_000,
              models: [],
            }),
          });
        }
        if (href.includes("/strategy/free-tier-usage/mini")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              tier: "mini",
              label: "Mini & nano models",
              usedTokens: 0,
              dailyLimitTokens: 2_500_000,
              remainingTokens: 2_500_000,
              models: [],
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ deterministic: [], llm: [] }) });
      }),
    );

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByText("Flagship daily tokens")).toBeInTheDocument();
    expect(screen.getByText("Mini & nano daily tokens")).toBeInTheDocument();
  });
});
