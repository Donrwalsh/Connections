import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Category } from "../data/samplePuzzle";

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
  date: "2024-01-15",
  categories,
  wordOrder: categories.flatMap((c) => c.words),
};

const strategyRun = {
  strategyName: "alphabetical",
  status: "completed",
  guesses: [
    {
      sequenceNumber: 1,
      words: ["HAIL", "RAIN", "SLEET", "SNOW"],
      result: "success",
      guessedAt: "2024-01-15T00:00:00Z",
    },
  ],
};

function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/strategy/")) {
        return Promise.resolve({ ok: true, json: async () => strategyRun });
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

    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Connections")).toBeInTheDocument();
  });

  it("renders the puzzle for a specific date route", async () => {
    setupFetch();

    render(
      <MemoryRouter initialEntries={["/puzzle/2024-01-15"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Connections")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2024-01-15")).toBeInTheDocument();
  });
});
