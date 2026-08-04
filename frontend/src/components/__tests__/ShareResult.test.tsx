import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Difficulty } from "../../data/samplePuzzle";
import { buildShareText } from "../../lib/shareResult";
import { ShareResult } from "../ShareResult";

describe("ShareResult Component", () => {
  const guessHistory: Difficulty[][] = [
    ["yellow", "yellow", "green", "green"],
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the share text", () => {
    render(<ShareResult guessHistory={guessHistory} puzzleDate="2024-01-15" />);

    expect(
      screen.getByText((content) => content.includes("🟨🟨🟩🟩")),
    ).toBeInTheDocument();
    expect(screen.getByText("Copy results")).toBeInTheDocument();
  });

  it("copies the results to the clipboard when clicked", async () => {
    render(<ShareResult guessHistory={guessHistory} puzzleDate="2024-01-15" />);

    fireEvent.click(screen.getByText("Copy results"));
    await act(async () => {});

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      buildShareText(guessHistory, "2024-01-15"),
    );
  });

  it("shows a copied confirmation and then reverts after 2 seconds", async () => {
    render(<ShareResult guessHistory={guessHistory} puzzleDate="2024-01-15" />);

    fireEvent.click(screen.getByText("Copy results"));

    await act(async () => {});
    expect(screen.getByText("Copied!")).toBeInTheDocument();
    expect(screen.queryByText("Copy results")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
    expect(screen.getByText("Copy results")).toBeInTheDocument();
  });
});
