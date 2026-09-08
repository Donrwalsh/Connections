import { describe, expect, it } from "vitest";
import {
  PROVIDER_POOLS,
  parseProviderParam,
  poolFromStrategyName,
  providerPoolLabel,
  serializeProviderParam,
} from "./providerPools";

describe("poolFromStrategyName", () => {
  it("maps each llm-* dispatching strategy to its pool id", () => {
    expect(poolFromStrategyName("llm-openai")).toBe("openai");
    expect(poolFromStrategyName("llm-google")).toBe("google");
    expect(poolFromStrategyName("llm-groq")).toBe("groq");
    expect(poolFromStrategyName("llm-openrouter")).toBe("openrouter");
    expect(poolFromStrategyName("llm-mistral")).toBe("mistral");
    expect(poolFromStrategyName("llm-sambanova")).toBe("sambanova");
    expect(poolFromStrategyName("llm-ollama")).toBe("ollama");
  });

  it("returns null for non-LLM strategies and unknown names", () => {
    expect(poolFromStrategyName("alphabetical")).toBeNull();
    expect(poolFromStrategyName("shuffle-smart")).toBeNull();
    expect(poolFromStrategyName("llm-unknown")).toBeNull();
    expect(poolFromStrategyName(null)).toBeNull();
    expect(poolFromStrategyName(undefined)).toBeNull();
  });
});

describe("providerPoolLabel", () => {
  it("gives the short provider name for a pool id", () => {
    expect(providerPoolLabel("groq")).toBe("Groq");
    expect(providerPoolLabel("openrouter")).toBe("OpenRouter");
    expect(providerPoolLabel("sambanova")).toBe("SambaNova");
  });
});

describe("PROVIDER_POOLS", () => {
  it("covers all seven pools once, in a stable order", () => {
    expect(PROVIDER_POOLS.map((p) => p.id)).toEqual([
      "openai",
      "google",
      "groq",
      "openrouter",
      "mistral",
      "sambanova",
      "ollama",
    ]);
  });
});

describe("parseProviderParam", () => {
  it("reads a comma-separated list into a set of known pool ids", () => {
    expect([...parseProviderParam("groq,openai")].sort()).toEqual(["groq", "openai"]);
  });

  it("ignores unknown tokens, blanks, and surrounding whitespace", () => {
    expect([...parseProviderParam(" groq , , bogus ,mistral")].sort()).toEqual([
      "groq",
      "mistral",
    ]);
  });

  it("returns an empty set for null or an empty string", () => {
    expect(parseProviderParam(null).size).toBe(0);
    expect(parseProviderParam("").size).toBe(0);
  });
});

describe("serializeProviderParam", () => {
  it("emits selected ids in canonical PROVIDER_POOLS order regardless of input order", () => {
    expect(serializeProviderParam(["mistral", "openai", "groq"])).toBe("openai,groq,mistral");
  });

  it("returns null when nothing is selected so the query param can be dropped", () => {
    expect(serializeProviderParam([])).toBeNull();
  });

  it("round-trips with parseProviderParam", () => {
    const serialized = serializeProviderParam(["sambanova", "google"]);
    expect(serialized).not.toBeNull();
    expect([...parseProviderParam(serialized)].sort()).toEqual(["google", "sambanova"]);
  });
});
