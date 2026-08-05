import { describe, expect, it } from "vitest";
import { renderProposedGroup } from "../renderProposedGroup";

describe("renderProposedGroup", () => {
  const group = {
    word_ids: [2, 7, 8, 10],
    category: "WET WEATHER",
    confidence: 0.95,
    reasoning: "All forms of precipitation",
  };

  it("injects each word as a comment next to its index", () => {
    const result = renderProposedGroup(group, [
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
    ]);

    expect(result).toContain('  "word_ids": [');
    expect(result).toContain("2,  // SLEET");
    expect(result).toContain("7,  // NETS");
    expect(result).toContain("8,  // OPTION");
    expect(result).toContain("10  // SHIFT");
  });

  it("aligns comments for multi-digit indices", () => {
    const words = [
      "W0",
      "W1",
      "W2",
      "W3",
      "W4",
      "W5",
      "W6",
      "W7",
      "W8",
      "W9",
      "W10",
    ];
    const result = renderProposedGroup(
      { ...group, word_ids: [10, 2, 3, 4] },
      words,
    );

    expect(result).toContain("10,  // W10");
    expect(result).toContain("2,   // W2");
    expect(result).toContain("3,   // W3");
    expect(result).toContain("4    // W4");
  });

  it("keeps the other fields in JSON form", () => {
    const result = renderProposedGroup(group, []);

    expect(result).toContain('"category": "WET WEATHER"');
    expect(result).toContain('"confidence": 0.95');
    expect(result).toContain('"reasoning": "All forms of precipitation"');
  });

  it("leaves an index without a word uncommented", () => {
    const result = renderProposedGroup(group, []);

    expect(result).toContain("    2,");
    expect(result).not.toContain("//");
  });

  it("falls back to plain JSON when the shape is unexpected", () => {
    const result = renderProposedGroup(
      { category: "Things" } as Record<string, unknown>,
      [],
    );

    expect(result).toBe('{\n  "category": "Things"\n}');
  });
});
