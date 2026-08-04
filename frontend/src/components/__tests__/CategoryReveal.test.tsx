import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Category } from "../../data/types";
import { CategoryReveal } from "../CategoryReveal";

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

describe("CategoryReveal Component", () => {
  it("renders nothing when there are no solved categories", () => {
    render(<CategoryReveal solved={[]} />);

    expect(screen.queryByText(/WET WEATHER/)).not.toBeInTheDocument();
  });

  it("renders each solved category's name and words", () => {
    render(<CategoryReveal solved={categories} />);

    expect(screen.getByText("WET WEATHER")).toBeInTheDocument();
    expect(screen.getByText(/RAIN, SNOW/)).toBeInTheDocument();
    expect(screen.getByText("NBA TEAMS")).toBeInTheDocument();
    expect(screen.getByText(/BUCKS, NETS/)).toBeInTheDocument();
  });

  it("applies the difficulty class to each row", () => {
    const { container } = render(<CategoryReveal solved={categories} />);

    const rows = container.querySelectorAll(".solved-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass("solved-row--yellow");
    expect(rows[1]).toHaveClass("solved-row--blue");
  });
});
