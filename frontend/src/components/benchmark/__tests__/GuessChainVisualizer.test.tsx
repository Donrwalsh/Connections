import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GuessChainVisualizer } from "../GuessChainVisualizer";

describe("GuessChainVisualizer", () => {
  it("surfaces the runId it is asked to visualize", () => {
    render(<GuessChainVisualizer runId={12345} />);

    expect(screen.getByRole("heading", { name: "Guess chain" })).toBeInTheDocument();
    expect(screen.getByText("#12345")).toBeInTheDocument();
  });

  it("labels the section with the run id", () => {
    render(<GuessChainVisualizer runId={99} />);

    expect(screen.getByLabelText("Guess chain for run 99")).toBeInTheDocument();
  });
});
