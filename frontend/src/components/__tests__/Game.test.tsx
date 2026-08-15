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
  vi.useRealTimers();
});

describe("Game Component", () => {
  it("renders the date and all 16 words", () => {
    render(<Game puzzle={puzzle} />);

    expect(screen.getByText("Monday, January 15, 2024")).toBeInTheDocument();
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
            groups: [
              {
                category: "WET WEATHER",
                items: ["HAIL", "RAIN", "SLEET", "SNOW"],
                confidence: 0.95,
              },
              {
                category: "NBA TEAMS",
                items: ["BUCKS", "HEAT", "JAZZ", "NETS"],
                confidence: 0.8,
              },
            ],
            prompt: "Find the four connected words.",
          },
        }),
      }),
    );

    render(<Game puzzle={puzzle} />);
    fireEvent.click(screen.getByText("AI Assist"));

    expect(await screen.findByText(/WET WEATHER/)).toBeInTheDocument();
    // The diagnostic echoes the board words themselves, not word indices.
    expect(screen.getByText(/HAIL.*RAIN.*SLEET.*SNOW/)).toBeInTheDocument();
    expect(screen.getByText(/BUCKS.*HEAT.*JAZZ.*NETS/)).toBeInTheDocument();
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

  it("shows a retrying status message while the AI request is slow, then clears it on success", async () => {
    vi.useFakeTimers();
    let resolveFetch: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    render(<Game puzzle={puzzle} />);
    fireEvent.click(screen.getByText("AI Assist"));

    expect(
      screen.queryByText(/Taking longer than expected/),
    ).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText(/Taking longer than expected/),
    ).toBeInTheDocument();

    await act(async () => {
      resolveFetch?.({
        ok: true,
        json: async () => ({
          orchestrator: "healthy",
          data: {
            groups: [
              {
                category: "WET WEATHER",
                items: ["HAIL", "RAIN", "SLEET", "SNOW"],
                confidence: 0.95,
              },
            ],
            prompt: "Find the four connected words.",
          },
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/WET WEATHER/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Taking longer than expected/),
    ).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows the backend's retry-exhausted error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          orchestrator: "unhealthy",
          error: "AI solve request failed after 4 attempts: Request timed out",
        }),
      }),
    );

    render(<Game puzzle={puzzle} />);
    fireEvent.click(screen.getByText("AI Assist"));

    expect(
      await screen.findByText(/AI solve request failed after 4 attempts/),
    ).toBeInTheDocument();
  });
});
