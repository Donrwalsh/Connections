import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStrategyMeta } from "./useStrategyMeta";
import type { SupportedModelRecord } from "./types";

function stubModelsFetch(models: SupportedModelRecord[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => models })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useStrategyMeta", () => {
  it("resolves an LLM row's description from live model data even when the static catalog recognizes the id", async () => {
    stubModelsFetch([
      {
        id: 1,
        strategyName: "llm-openai",
        modelName: "gpt-4.1-nano-2025-04-14",
        inputCostPerMillionTokens: 0.1,
        outputCostPerMillionTokens: 0.4,
        supported: true,
        contextWindow: 128000,
        paramCount: null,
        providerDescription: null,
        releaseDate: null,
      },
    ]);

    const { result } = renderHook(() => useStrategyMeta("gpt-4.1-nano-2025-04-14"));

    await waitFor(() => {
      expect(result.current.meta?.description).toBe(
        "OpenAI gpt-4.1-nano-2025-04-14 · 128K context",
      );
    });

    // Identity/copy still comes from the static catalog, not synthesized.
    expect(result.current.meta?.name).toBe("LLM · gpt-4.1-nano-2025-04-14");
    expect(result.current.meta?.kind).toBe("llm");
    expect(result.current.meta?.strategyName).toBe("llm-openai");
  });

  it("does not fetch live model data for a non-LLM strategyId", async () => {
    stubModelsFetch([]);

    const { result } = renderHook(() => useStrategyMeta("alphabetical"));

    expect(result.current.meta?.description).toBe(
      "Deterministic · tries words in alphabetical order",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
