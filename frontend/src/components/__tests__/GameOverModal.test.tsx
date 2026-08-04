import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Category } from "../../data/types";
import { GameOverModal } from "../GameOverModal";

const categories: Category[] = [
  {
    id: "cat-1",
    name: "WET WEATHER",
    difficulty: "yellow",
    words: ["RAIN", "SNOW"],
  },
  {
    id: "cat-2",
    name: "NBA TEAMS",
    difficulty: "blue",
    words: ["BUCKS", "NETS"],
  },
];

describe("GameOverModal Component", () => {
  it("shows a win title when the status is won", () => {
    render(
      <GameOverModal
        status="won"
        categories={categories}
        guessHistory={[]}
        puzzleDate="2024-01-15"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Solved it!")).toBeInTheDocument();
  });

  it("shows a loss title and reveals the answers when the status is lost", () => {
    render(
      <GameOverModal
        status="lost"
        categories={categories}
        guessHistory={[]}
        puzzleDate="2024-01-15"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Next time!")).toBeInTheDocument();
    expect(screen.getByText(/WET WEATHER/)).toBeInTheDocument();
    expect(screen.getByText(/NBA TEAMS/)).toBeInTheDocument();
  });

  it("does not reveal the answers when the status is won", () => {
    render(
      <GameOverModal
        status="won"
        categories={categories}
        guessHistory={[]}
        puzzleDate="2024-01-15"
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText(/WET WEATHER/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NBA TEAMS/)).not.toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <GameOverModal
        status="won"
        categories={categories}
        guessHistory={[]}
        puzzleDate="2024-01-15"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the share result section", () => {
    render(
      <GameOverModal
        status="won"
        categories={categories}
        guessHistory={[]}
        puzzleDate="2024-01-15"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Copy results")).toBeInTheDocument();
  });
});
