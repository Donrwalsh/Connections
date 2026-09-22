import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStrategyMeta } from "./useStrategyMeta";
import type { SupportedModelRecord } from "./types";

// Routes by URL like the real backend: the bulk allowlist
// (GET /strategy/models) always returns every row, while the resolve
// endpoint (GET /strategy/models/:modelName/strategy) mirrors
// resolveSupportedStrategy's own semantics — one match resolves, zero or
// more than one rejects with a 400 (see useStrategyMeta's own doc comment
// for why the hook depends on that distinction, not just the bulk list).
function stubModelsFetch(models: SupportedModelRecord[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      const resolveMatch = href.match(/\/strategy\/models\/([^/]+)\/strategy$/);
      if (resolveMatch) {
        const modelName = decodeURIComponent(resolveMatch[1]!);
        const matches = models.filter((model) => model.modelName === modelName);
        if (matches.length === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ modelName, strategyName: matches[0]!.strategyName }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            message:
              matches.length === 0
                ? `Model '${modelName}' is not a supported model.`
                : `Model '${modelName}' is ambiguous — it is configured as supported under` +
                  ` multiple strategies (${matches.map((m) => m.strategyName).join(", ")}).`,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => models });
    }),
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

  it("resolves a Google model's provider label correctly", async () => {
    stubModelsFetch([
      {
        id: 2,
        strategyName: "llm-google",
        modelName: "gemini-3.6-flash",
        inputCostPerMillionTokens: 0.3,
        outputCostPerMillionTokens: 2.5,
        supported: true,
        contextWindow: 1048576,
        paramCount: null,
        providerDescription: null,
        releaseDate: null,
      },
    ]);

    const { result } = renderHook(() => useStrategyMeta("gemini-3.6-flash"));

    await waitFor(() => {
      expect(result.current.meta?.description).toBe("Google gemini-3.6-flash · 1049K context");
    });

    expect(result.current.meta?.name).toBe("LLM · gemini-3.6-flash");
    expect(result.current.meta?.strategyName).toBe("llm-google");
  });

  it("labels a Groq-served model Groq for an id the static catalog doesn't know", async () => {
    stubModelsFetch([
      {
        id: 3,
        strategyName: "llm-groq",
        modelName: "openai/gpt-oss-20b",
        inputCostPerMillionTokens: null,
        outputCostPerMillionTokens: null,
        supported: true,
        contextWindow: 131072,
        paramCount: null,
        providerDescription: null,
        releaseDate: null,
      },
    ]);

    const { result } = renderHook(() => useStrategyMeta("openai/gpt-oss-20b"));

    await waitFor(() => {
      expect(result.current.meta?.description).toBe("Groq openai/gpt-oss-20b · 131K context");
    });

    expect(result.current.meta?.strategyName).toBe("llm-groq");
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
