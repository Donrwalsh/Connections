import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Board } from "../Board";

describe("Board Component", () => {
  const words = ["APPLE", "BANANA", "CHERRY", "DONUT"];

  it("renders all words as tiles", () => {
    render(
      <Board
        words={words}
        selected={[]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={() => {}}
      />,
    );

    words.forEach((word) => expect(screen.getByText(word)).toBeInTheDocument());
  });

  it("calls onToggle with the word when a tile is clicked", () => {
    const onToggle = vi.fn();
    render(
      <Board
        words={words}
        selected={[]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByText("APPLE"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("APPLE");
  });

  it("marks selected words with the selected class", () => {
    render(
      <Board
        words={words}
        selected={["APPLE"]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText("APPLE")).toHaveClass("tile--selected");
    expect(screen.getByText("BANANA")).not.toHaveClass("tile--selected");
  });

  it("marks confirmed words with the confirmed class", () => {
    render(
      <Board
        words={words}
        selected={[]}
        shakeWords={[]}
        confirmedWords={["APPLE"]}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText("APPLE")).toHaveClass("tile--confirmed");
  });

  it("renders an empty board when there are no words", () => {
    const { container } = render(
      <Board
        words={[]}
        selected={[]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={() => {}}
      />,
    );

    expect(container.querySelectorAll(".tile")).toHaveLength(0);
  });

  it("passes each word's image URL through to its tile", () => {
    render(
      <Board
        words={["APPLE"]}
        images={{ APPLE: "https://example.com/apple.svg" }}
        selected={[]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByRole("img", { name: "APPLE" })).toHaveAttribute(
      "src",
      "https://example.com/apple.svg",
    );
  });

  it("renders text tiles for words with no entry in images", () => {
    render(
      <Board
        words={["APPLE"]}
        images={{ BANANA: "https://example.com/banana.svg" }}
        selected={[]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText("APPLE")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
