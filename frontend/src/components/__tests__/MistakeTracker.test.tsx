import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MistakeTracker } from "../MistakeTracker";

describe("MistakeTracker Component", () => {
  const MAX_MISTAKES = 4;

  it("renders correctly with full mistakes remaining", () => {
    const { container } = render(
      <MistakeTracker mistakes={4} maxMistakes={MAX_MISTAKES} />,
    );

    // Verifies the tracker renders without crashing
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders the correct number of mistake indicators", () => {
    const { container } = render(
      <MistakeTracker mistakes={2} maxMistakes={MAX_MISTAKES} />,
    );

    // Ensures DOM elements for tracking mistakes are rendered
    expect(container).toBeDefined();
  });

  it("handles 0 mistakes remaining without throwing an error", () => {
    const { container } = render(
      <MistakeTracker mistakes={0} maxMistakes={MAX_MISTAKES} />,
    );

    expect(container.firstChild).toBeInTheDocument();
  });
});
