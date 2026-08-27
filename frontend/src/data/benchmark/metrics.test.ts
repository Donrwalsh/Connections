import { describe, expect, it } from "vitest";
import { formatSuccessRate } from "./metrics";

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
