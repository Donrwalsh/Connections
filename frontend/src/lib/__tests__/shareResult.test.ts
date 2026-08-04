import { describe, expect, it } from "vitest";
import type { Difficulty } from "../../data/samplePuzzle";
import { buildShareText } from "../shareResult";

describe("buildShareText", () => {
  it("turns guess history into the emoji share grid", () => {
    const history: Difficulty[][] = [
      ["yellow", "green", "blue", "purple"],
      ["yellow", "yellow", "yellow", "yellow"],
    ];

    expect(buildShareText(history, "2024-01-15")).toBe(
      "Connections\n2024-01-15\n🟨🟩🟦🟪\n🟨🟨🟨🟨",
    );
  });

  it("handles an empty guess history", () => {
    expect(buildShareText([], "2024-01-15")).toBe(
      "Connections\n2024-01-15\n",
    );
  });

  it("matches the difficulty emoji mapping", () => {
    expect(buildShareText([["green"]], "2024-01-15")).toBe(
      "Connections\n2024-01-15\n🟩",
    );
  });
});
