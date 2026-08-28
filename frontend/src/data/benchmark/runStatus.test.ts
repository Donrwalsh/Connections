import { describe, expect, it } from "vitest";
import { isFailedStatus, runStatusLabel, runStatusTone } from "./runStatus";

describe("rateLimitedDaily run status", () => {
  it("labels it as a daily-quota pause", () => {
    expect(runStatusLabel("rateLimitedDaily")).toBe("Paused — daily quota");
  });

  it("tones it as an in-progress state, not a failure", () => {
    expect(runStatusTone("rateLimitedDaily")).toBe("active");
    expect(isFailedStatus("rateLimitedDaily")).toBe(false);
  });
});
