import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultProvider,
  getContextWindow,
  getModel,
  getModelName,
} from "./provider.js";

const createOllamaMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const openaiMock = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("ai-sdk-ollama", () => ({
  createOllama: createOllamaMock,
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: openaiMock,
}));

describe("getModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    createOllamaMock.mockClear();
    openaiMock.mockClear();
  });

  it("passes num_ctx from MODEL_CONTEXT_WINDOW to the Ollama model", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");

    getModel("ollama");

    expect(createOllamaMock).toHaveBeenCalledTimes(1);
    const modelFactory = createOllamaMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("llama3.2", {
      options: { num_ctx: 2048 },
    });
    expect(openaiMock).not.toHaveBeenCalled();
  });

  it("defaults num_ctx to 8192 when MODEL_CONTEXT_WINDOW is unset", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "");

    getModel("ollama");

    const modelFactory = createOllamaMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("llama3.2", {
      options: { num_ctx: 8192 },
    });
  });

  it("resolves the OpenAI model without num_ctx", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");

    getModel("openai");

    expect(openaiMock).toHaveBeenCalledTimes(1);
    expect(openaiMock).toHaveBeenCalledWith("gpt-4o-2024-08-06");
    expect(createOllamaMock).not.toHaveBeenCalled();
  });
});

describe("getModelName", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured OpenAI model for the openai provider", () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");
    expect(getModelName("openai")).toBe("gpt-4o-mini");
  });

  it("returns the configured Ollama model for the ollama provider", () => {
    vi.stubEnv("OLLAMA_MODEL", "llama3.3");
    expect(getModelName("ollama")).toBe("llama3.3");
  });

  it("falls back to the defaults when unset", () => {
    expect(getModelName("openai")).toBe("gpt-4o-2024-08-06");
    expect(getModelName("ollama")).toBe("llama3.2");
  });
});

describe("defaultProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to openai when MODEL_PROVIDER is unset or unknown", () => {
    expect(defaultProvider()).toBe("openai");
    vi.stubEnv("MODEL_PROVIDER", "weird");
    expect(defaultProvider()).toBe("openai");
  });

  it("returns ollama when MODEL_PROVIDER is set to ollama", () => {
    vi.stubEnv("MODEL_PROVIDER", "ollama");
    expect(defaultProvider()).toBe("ollama");
  });
});

describe("getContextWindow", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a positive MODEL_CONTEXT_WINDOW", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");
    expect(getContextWindow()).toBe(2048);
  });

  it("falls back to the default for missing or invalid values", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "");
    expect(getContextWindow()).toBe(8192);
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "0");
    expect(getContextWindow()).toBe(8192);
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "not-a-number");
    expect(getContextWindow()).toBe(8192);
  });
});
