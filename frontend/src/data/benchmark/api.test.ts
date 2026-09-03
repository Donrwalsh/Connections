import { describe, expect, it } from "vitest";
import { toRunRecord } from "./api";
import type { StrategyRunListItem } from "./types";

function makeItem(overrides: Partial<StrategyRunListItem> = {}): StrategyRunListItem {
  return {
    id: 1,
    strategyName: "llm-openai",
    trialNumber: 0,
    status: "completed",
    modelName: "gpt-4.1-nano",
    contextWindow: null,
    startedAt: "2024-01-01T00:00:00Z",
    finishedAt: "2024-01-01T03:00:00Z",
    solveDurationMs: null,
    guessCount: 4,
    ...overrides,
  };
}

describe("toRunRecord", () => {
  it("uses solveDurationMs for durationMs when the backend provides it", () => {
    const record = toRunRecord(makeItem({ solveDurationMs: 6000 }));

    // Not the 3-hour wall-clock span between startedAt and finishedAt.
    expect(record.durationMs).toBe(6000);
  });

  it("falls back to wall-clock when solveDurationMs is null (deterministic run)", () => {
    const record = toRunRecord(
      makeItem({
        strategyName: "shuffle-smart",
        modelName: null,
        startedAt: "2024-01-01T00:00:00Z",
        finishedAt: "2024-01-01T00:00:05Z",
        solveDurationMs: null,
      }),
    );

    expect(record.durationMs).toBe(5000);
  });

  it("keeps a real 0ms sum rather than falling back to wall-clock", () => {
    const record = toRunRecord(makeItem({ solveDurationMs: 0 }));

    expect(record.durationMs).toBe(0);
  });
});
