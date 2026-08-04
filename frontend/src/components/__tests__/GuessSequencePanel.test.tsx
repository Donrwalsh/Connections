import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuessSequencePanel } from "../GuessSequencePanel";

const strategyRun = {
  strategyName: "alphabetical",
  status: "completed",
  guesses: [
    {
      sequenceNumber: 1,
      words: ["A", "B", "C", "D"],
      result: "success",
      guessedAt: "2024-01-15T00:00:00Z",
    },
    {
      sequenceNumber: 2,
      words: ["E", "F", "G", "H"],
      result: "offBy1",
      guessedAt: "2024-01-15T00:00:00Z",
    },
    {
      sequenceNumber: 3,
      words: ["I", "J", "K", "L"],
      result: "failure",
      guessedAt: "2024-01-15T00:00:00Z",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const strategyId =
        String(url).match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
      return Promise.resolve({
        ok: true,
        json: async () => ({ ...strategyRun, strategyName: strategyId }),
      });
    }),
  );
}

describe("GuessSequencePanel Component", () => {
  it("shows a loading message while strategies are fetching", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    expect(
      screen.getByText("Loading Alphabetical guesses..."),
    ).toBeInTheDocument();
  });

  it("shows strategy step counts on the toggle buttons", async () => {
    setupFetch();

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={false} onToggle={() => {}} />,
    );

    expect(
      await screen.findByRole("button", { name: /Show Alphabetical \(3\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Show Rev-Alphabetical \(3\)/ }),
    ).toBeInTheDocument();
  });

  it("shows the guesses for the active strategy when open", async () => {
    setupFetch();

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    expect(
      await screen.findByText("Strategy: Alphabetical · Status: completed · 3 guesses"),
    ).toBeInTheDocument();
    expect(screen.getByText("A, B, C, D")).toBeInTheDocument();
    expect(screen.getByText("✓ Correct")).toBeInTheDocument();
    expect(screen.getByText("One away")).toBeInTheDocument();
    expect(screen.getByText("✗ Incorrect")).toBeInTheDocument();
  });

  it("calls onToggle to open the panel when a strategy button is clicked while closed", async () => {
    setupFetch();

    const onToggle = vi.fn();
    render(
      <GuessSequencePanel date="2024-01-15" isOpen={false} onToggle={onToggle} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show Alphabetical/ }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onToggle to close the panel when the active strategy is clicked while open", async () => {
    setupFetch();

    const onToggle = vi.fn();
    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={onToggle} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Hide Alphabetical/ }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("switches the active strategy when a different strategy is clicked while open", async () => {
    setupFetch();

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show Rev-Alphabetical/ }),
    );

    expect(
      await screen.findByText(
        "Strategy: Reverse Alphabetical · Status: completed · 3 guesses",
      ),
    ).toBeInTheDocument();
  });

  it("shows an error message when a strategy fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });
});
