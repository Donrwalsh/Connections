import {
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category, Puzzle } from "../../data/types";
import { Game } from "../Game";

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

const puzzle: Puzzle = {
  date: "2024-01-15",
  categories,
  wordOrder: [
    "HAIL",
    "RAIN",
    "SLEET",
    "SNOW",
    "BUCKS",
    "HEAT",
    "JAZZ",
    "NETS",
    "OPTION",
    "RETURN",
    "SHIFT",
    "TAB",
    "KAYAK",
    "LEVEL",
    "MOM",
    "RACECAR",
  ],
};

function wrongGroup(offset: number): string[] {
  return categories.map((c) => c.words[offset]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Game Component", () => {
  it("renders the title and all 16 words", () => {
    render(<Game puzzle={puzzle} />);

    expect(screen.getByText("Connections")).toBeInTheDocument();
    const words = categories.flatMap((c) => c.words);
    words.forEach((word) => expect(screen.getByText(word)).toBeInTheDocument());
    expect(screen.getByText("0/4 selected")).toBeInTheDocument();
  });

  it("tracks the selected count when tiles are toggled", () => {
    render(<Game puzzle={puzzle} />);

    fireEvent.click(screen.getByText("HAIL"));
    expect(screen.getByText("1/4 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByText("RAIN"));
    expect(screen.getByText("2/4 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByText("HAIL"));
    expect(screen.getByText("1/4 selected")).toBeInTheDocument();
  });

  it("disables Submit until exactly four words are selected", () => {
    render(<Game puzzle={puzzle} />);

    const submit = screen.getByText("Submit");
    expect(submit).toBeDisabled();

    ["HAIL", "RAIN", "SLEET"].forEach((word) =>
      fireEvent.click(screen.getByText(word)),
    );
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByText("SNOW"));
    expect(submit).not.toBeDisabled();
  });

  it("keeps all words on the board after shuffling", () => {
    render(<Game puzzle={puzzle} />);

    fireEvent.click(screen.getByText("Shuffle"));

    const words = categories.flatMap((c) => c.words);
    words.forEach((word) => expect(screen.getByText(word)).toBeInTheDocument());
  });

  it("deselects all words when Deselect all is clicked", () => {
    render(<Game puzzle={puzzle} />);

    fireEvent.click(screen.getByText("HAIL"));
    fireEvent.click(screen.getByText("RAIN"));
    expect(screen.getByText("2/4 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Deselect all"));
    expect(screen.getByText("0/4 selected")).toBeInTheDocument();
  });

  it("shows one-away feedback for a near-miss guess", async () => {
    render(<Game puzzle={puzzle} />);

    ["HAIL", "RAIN", "SLEET", "BUCKS"].forEach((word) =>
      fireEvent.click(screen.getByText(word)),
    );
    fireEvent.click(screen.getByText("Submit"));

    expect(await screen.findByText("One away...")).toBeInTheDocument();
  });

  it("shows incorrect feedback for a wrong guess", async () => {
    render(<Game puzzle={puzzle} />);

    wrongGroup(0).forEach((word) => fireEvent.click(screen.getByText(word)));
    fireEvent.click(screen.getByText("Submit"));

    expect(await screen.findByText("Not quite.")).toBeInTheDocument();
  });

  it("wins the game when all categories are solved", async () => {
    render(<Game puzzle={puzzle} />);

    for (const cat of categories) {
      cat.words.forEach((word) => fireEvent.click(screen.getByText(word)));
      fireEvent.click(screen.getByText("Submit"));

      expect(await screen.findByText(cat.name)).toBeInTheDocument();
    }

    expect(await screen.findByText("Solved it!")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByText("Solved it!")).not.toBeInTheDocument();
  }, 15000);

  it("loses the game after four incorrect guesses and reveals the answers", async () => {
    render(<Game puzzle={puzzle} />);

    for (let i = 0; i < 4; i++) {
      wrongGroup(i).forEach((word) => fireEvent.click(screen.getByText(word)));
      fireEvent.click(screen.getByText("Submit"));
    }

    expect(await screen.findByText("Next time!")).toBeInTheDocument();
    expect(screen.getByText("WET WEATHER")).toBeInTheDocument();
    expect(screen.getByText(/HAIL, RAIN, SLEET, SNOW/)).toBeInTheDocument();
    expect(screen.getByText(/KAYAK, LEVEL, MOM, RACECAR/)).toBeInTheDocument();
  });

  it("displays an AI recommendation when AI assist succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          orchestrator: "healthy",
          data: {
            proposedGroup: {
              word_ids: [0, 1, 2, 3],
              category: "WET WEATHER",
              confidence: 0.95,
              reasoning: "All forms of precipitation",
            },
            prompt: "Find the four connected words.",
          },
        }),
      }),
    );

    render(<Game puzzle={puzzle} />);
    fireEvent.click(screen.getByText("AI Assist"));

    expect(await screen.findByText(/WET WEATHER/)).toBeInTheDocument();
    // Comments resolve each word index back to a word on the board.
    expect(screen.getByText(/\/\/ [A-Z]+/)).toBeInTheDocument();
    expect(screen.getByText("View prompt sent to the model")).toBeInTheDocument();
  });

  it("shows an error when the AI orchestrator is unhealthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          orchestrator: "unhealthy",
          error: "orchestrator down",
        }),
      }),
    );

    render(<Game puzzle={puzzle} />);
    fireEvent.click(screen.getByText("AI Assist"));

    expect(
      await screen.findByText(/AI Assist unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByText(/orchestrator down/)).toBeInTheDocument();
  });

  it("shows an error when the AI request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network failure")),
    );

    render(<Game puzzle={puzzle} />);
    fireEvent.click(screen.getByText("AI Assist"));

    expect(await screen.findByText(/network failure/)).toBeInTheDocument();
  });

  it("shows a timeout message when the AI assist request times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              const error = new Error("The operation was aborted.");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );

    render(<Game puzzle={puzzle} />);
    fireEvent.click(screen.getByText("AI Assist"));

    await act(async () => {
      vi.advanceTimersByTime(8000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/timed out/i)).toBeInTheDocument();
    vi.useRealTimers();
  });
});
