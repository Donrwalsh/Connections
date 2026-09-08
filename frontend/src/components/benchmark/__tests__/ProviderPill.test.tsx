import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderPill } from "../ProviderPill";

describe("ProviderPill", () => {
  it("renders the pool's short label with a pool-specific tone class", () => {
    render(<ProviderPill strategyName="llm-groq" />);

    const pill = screen.getByText("Groq");
    expect(pill).toHaveClass("bench-pill", "bench-pill--groq");
  });

  it("labels a SambaNova-served run as SambaNova, not by the model vendor", () => {
    render(<ProviderPill strategyName="llm-sambanova" />);

    expect(screen.getByText("SambaNova")).toBeInTheDocument();
  });

  it("renders nothing for a strategy that has no provider pool", () => {
    const { container } = render(<ProviderPill strategyName="alphabetical" />);

    expect(container).toBeEmptyDOMElement();
  });
});
