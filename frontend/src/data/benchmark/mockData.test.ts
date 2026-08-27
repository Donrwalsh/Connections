import { describe, expect, it } from "vitest";
import { describeLeaderboardRow } from "./mockData";
import type { LeaderboardRow } from "./types";

function makeLlmRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    id: "gpt-4.1-nano-2025-04-14",
    strategyName: "llm-openai",
    modelName: "gpt-4.1-nano-2025-04-14",
    kind: "llm",
    puzzlesCovered: 1,
    totalPuzzles: 1,
    progress: { completed: 1, active: 0, failed: 0, queued: 0 },
    successRate: 100,
    avgGuessesToSolve: 4,
    minGuesses: 4,
    maxGuesses: 4,
    avgDurationMs: 1000,
    avgCostUsd: 0.1,
    totalCostUsd: 0.1,
    avgIssues: null,
    contextWindow: null,
    paramCount: null,
    providerDescription: null,
    ...overrides,
  };
}

describe("describeLeaderboardRow", () => {
  it("builds an LLM row's description from live context/param data even when the static catalog recognizes the id", () => {
    const row = makeLlmRow({ contextWindow: 128000, paramCount: null });

    const { description } = describeLeaderboardRow(row);

    expect(description).toBe("OpenAI gpt-4.1-nano-2025-04-14 · 128K context");
  });

  it("falls back to the generic sentence for an LLM row with no known context/params yet", () => {
    const row = makeLlmRow({ contextWindow: null, paramCount: null });

    const { description } = describeLeaderboardRow(row);

    expect(description).toBe("OpenAI gpt-4.1-nano-2025-04-14 proposes candidate groups");
  });

  it("still resolves the static name for a recognized LLM id", () => {
    const row = makeLlmRow({ contextWindow: 128000 });

    const { name } = describeLeaderboardRow(row);

    expect(name).toBe("LLM · gpt-4.1-nano-2025-04-14");
  });

  it("labels the provider correctly for an Ollama row", () => {
    const row = makeLlmRow({
      id: "mistral-nemo",
      strategyName: "llm-ollama",
      modelName: "mistral-nemo",
      contextWindow: 131072,
      paramCount: 12_000_000_000,
    });

    const { description } = describeLeaderboardRow(row);

    expect(description).toBe("Ollama mistral-nemo · 131K context · 12B params");
  });

  it("labels the provider correctly for a Google row", () => {
    const row = makeLlmRow({
      id: "gemini-3.6-flash",
      strategyName: "llm-google",
      modelName: "gemini-3.6-flash",
      contextWindow: 1048576,
      paramCount: null,
    });

    const { description } = describeLeaderboardRow(row);

    expect(description).toBe("Google gemini-3.6-flash · 1049K context");
  });

  it("leaves deterministic rows unaffected", () => {
    const row: LeaderboardRow = {
      id: "alphabetical",
      strategyName: "alphabetical",
      modelName: null,
      kind: "deterministic",
      puzzlesCovered: 1,
      totalPuzzles: 1,
      progress: { completed: 1, active: 0, failed: 0, queued: 0 },
      successRate: 100,
      avgGuessesToSolve: 4,
      minGuesses: 4,
      maxGuesses: 4,
      avgDurationMs: 1000,
      avgCostUsd: null,
      totalCostUsd: null,
      avgIssues: null,
      contextWindow: null,
      paramCount: null,
      providerDescription: null,
    };

    const { name, description } = describeLeaderboardRow(row);

    expect(name).toBe("Alphabetical");
    expect(description).toBe("Deterministic · tries words in alphabetical order");
  });
});
