import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Category } from "../../data/types";
import { PuzzlePage } from "../PuzzlePage";

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

let mockedParams: { date?: string } = {};

vi.mock("react-router-dom", () => ({
  useParams: () => mockedParams,
}));

function setupSuccessFetch() {
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

describe("PuzzlePage Component", () => {
  beforeEach(() => {
    mockedParams = { date: "2024-01-15" };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading message while fetching the puzzle", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<PuzzlePage />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders the puzzle after a successful fetch", async () => {
    setupSuccessFetch();

    render(<PuzzlePage />);

    expect(await screen.findByText("Monday, January 15, 2024")).toBeInTheDocument();
    expect(await screen.findByText("HAIL")).toBeInTheDocument();
    expect(
      await screen.findByText("Show Alphabetical (1)"),
    ).toBeInTheDocument();
  });

  it("shows an error message when fetching the puzzle fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<PuzzlePage />);

    expect(await screen.findByText(/Error: boom/)).toBeInTheDocument();
  });

  describe("when no date param is present (homepage route)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("requests the puzzle for the viewer's local calendar date, not UTC", async () => {
      mockedParams = {};
      // 2024-01-16T02:00:00Z is still 2024-01-15, 8pm in America/Chicago (UTC-6).
      // A viewer there should get the 15th's puzzle, not the UTC 16th's.
      vi.stubEnv("TZ", "America/Chicago");
      vi.setSystemTime(new Date("2024-01-16T02:00:00Z"));
      setupSuccessFetch();

      render(<PuzzlePage />);

      await screen.findByText("HAIL");

      const fetchMock = vi.mocked(fetch);
      const requestedUrl = String(fetchMock.mock.calls[0][0]);
      expect(requestedUrl).toContain("/game/puzzle/2024-01-15");
      expect(requestedUrl).not.toContain("/game/puzzle/today");
      expect(requestedUrl).not.toContain("2024-01-16");
    });
  });
});
