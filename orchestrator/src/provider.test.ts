import { afterEach, describe, expect, it, vi } from "vitest";
import { getContextWindow, getModel } from "./provider.js";

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
    vi.stubEnv("MODEL_PROVIDER", "ollama");
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");

    getModel();

    expect(createOllamaMock).toHaveBeenCalledTimes(1);
    const modelFactory = createOllamaMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("llama3.2", {
      options: { num_ctx: 2048 },
    });
  });

  it("defaults num_ctx to 8192 when MODEL_CONTEXT_WINDOW is unset", () => {
    vi.stubEnv("MODEL_PROVIDER", "ollama");
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "");

    getModel();

    const modelFactory = createOllamaMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("llama3.2", {
      options: { num_ctx: 8192 },
    });
  });

  it("does not apply num_ctx when using the OpenAI provider", () => {
    vi.stubEnv("MODEL_PROVIDER", "openai");
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");

    getModel();

    expect(openaiMock).toHaveBeenCalledTimes(1);
    expect(createOllamaMock).not.toHaveBeenCalled();
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
