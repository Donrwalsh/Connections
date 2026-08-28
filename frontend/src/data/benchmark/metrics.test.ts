import { describe, expect, it } from "vitest";
import {
  formatSuccessRate,
  getMetricDefinition,
  metricValue,
  sortStrategiesByMetric,
} from "./metrics";

const row = (id: string, categoryAccuracy: number | null) =>
  ({ id, avgGuessesToSolve: null, successRate: null, avgDurationMs: null, categoryAccuracy }) as never;

describe("categoryAccuracy metric", () => {
  it("sorts highest accuracy first, nulls last", () => {
    const sorted = sortStrategiesByMetric(
      [row("a", 40), row("b", null), row("c", 90)],
      "categoryAccuracy",
    );
    expect(sorted.map((r) => (r as { id: string }).id)).toEqual(["c", "a", "b"]);
  });

  it("reads the value and formats as a percent to 3 sig figs", () => {
    expect(metricValue(row("a", 33.333), "categoryAccuracy")).toBeCloseTo(33.333);
    expect(getMetricDefinition("categoryAccuracy").format(33.333)).toBe("33.3%");
  });
});

describe("formatSuccessRate", () => {
  it("shows 3 significant figures for a low rate instead of rounding to 0%", () => {
    expect(formatSuccessRate(0.333)).toBe("0.333%");
  });

  it("doesn't pad a round number with trailing zeros", () => {
    expect(formatSuccessRate(100)).toBe("100%");
    expect(formatSuccessRate(5)).toBe("5%");
  });

  it("rounds rather than truncates", () => {
    expect(formatSuccessRate(45.678)).toBe("45.7%");
  });
});
