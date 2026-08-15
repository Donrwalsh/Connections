import { describe, expect, it } from "vitest";
import { renderDiagnoseGroups } from "../renderDiagnoseGroups";

describe("renderDiagnoseGroups", () => {
  const groups = [
    {
      category: "WET WEATHER",
      items: ["HAIL", "RAIN", "SLEET", "SNOW"],
      confidence: 0.95,
    },
    {
      category: "NBA TEAMS",
      items: ["BUCKS", "HEAT", "JAZZ", "NETS"],
      confidence: 0.8,
    },
  ];

  it("pretty-prints the groups as JSON", () => {
    const result = renderDiagnoseGroups(groups);

    expect(result).toContain('"category": "WET WEATHER"');
    expect(result).toContain('"items": ["HAIL", "RAIN", "SLEET", "SNOW"]');
    expect(result).toContain('"confidence": 0.95');
    expect(result).toContain('"category": "NBA TEAMS"');
  });

  it("renders all groups, not just the first", () => {
    const result = renderDiagnoseGroups(groups);

    expect(result.match(/"category"/g)).toHaveLength(2);
    expect(result).toContain('"items": ["BUCKS", "HEAT", "JAZZ", "NETS"]');
  });

  it("falls back to plain JSON when the shape is unexpected", () => {
    const result = renderDiagnoseGroups({
      category: "Things",
    } as unknown);

    expect(result).toBe('{\n  "category": "Things"\n}');
  });

  it("falls back for non-array payloads", () => {
    const result = renderDiagnoseGroups("nope");

    expect(result).toBe('"nope"');
  });
});
