import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultProvider,
  effectiveContextWindow,
  getContextWindow,
  getModel,
  getModelName,
} from "./provider.js";

const createOllamaMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const openaiMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const createGoogleGenerativeAIMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const createGroqMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const openRouterChatMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const createOpenRouterMock = vi.hoisted(() => vi.fn(() => ({ chat: openRouterChatMock })));
const createMistralMock = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("ai-sdk-ollama", () => ({
  createOllama: createOllamaMock,
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: openaiMock,
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: createGoogleGenerativeAIMock,
}));

vi.mock("@ai-sdk/groq", () => ({
  createGroq: createGroqMock,
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: createOpenRouterMock,
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: createMistralMock,
}));

describe("getModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    createOllamaMock.mockClear();
    openaiMock.mockClear();
    createGoogleGenerativeAIMock.mockClear();
    createGroqMock.mockClear();
    createOpenRouterMock.mockClear();
    openRouterChatMock.mockClear();
    createMistralMock.mockClear();
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

  it("caps a model's real contextWindow at MODEL_CONTEXT_WINDOW rather than requesting it in full", () => {
    // A large num_ctx is reserved in full at model-load time regardless of
    // actual prompt length, so requesting a model's true context window
    // (e.g. mistral-nemo's 131,072) can OOM-kill Ollama's llama-server on
    // memory-constrained hardware even though puzzle prompts never come
    // close to using it. MODEL_CONTEXT_WINDOW caps what's actually
    // requested; SupportedModel.contextWindow (shown on the leaderboard)
    // stays the model's real, uncapped spec.
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");

    getModel("ollama", undefined, 131072);

    const modelFactory = createOllamaMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("llama3.2", {
      options: { num_ctx: 2048 },
    });
  });

  it("passes a contextWindow through as-is when it's already below the MODEL_CONTEXT_WINDOW ceiling", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "8192");

    getModel("ollama", undefined, 4096);

    const modelFactory = createOllamaMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("llama3.2", {
      options: { num_ctx: 4096 },
    });
  });

  it("resolves the OpenAI model without num_ctx", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");

    getModel("openai");

    expect(openaiMock).toHaveBeenCalledTimes(1);
    expect(openaiMock).toHaveBeenCalledWith("gpt-4.1-nano");
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("uses the model override instead of OPENAI_MODEL when given", () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-4.1-nano");

    getModel("openai", "gpt-5-nano");

    expect(openaiMock).toHaveBeenCalledWith("gpt-5-nano");
  });

  it("uses the model override instead of OLLAMA_MODEL when given", () => {
    vi.stubEnv("OLLAMA_MODEL", "llama3.2");

    getModel("ollama", "mistral");

    const modelFactory = createOllamaMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("mistral", {
      options: { num_ctx: 8192 },
    });
  });

  it("resolves the Google model without num_ctx", () => {
    getModel("google");

    expect(createGoogleGenerativeAIMock).toHaveBeenCalledTimes(1);
    const modelFactory = createGoogleGenerativeAIMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("gemini-3.6-flash");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes GOOGLE_API_KEY to createGoogleGenerativeAI", () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-google-key");

    getModel("google");

    expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({ apiKey: "test-google-key" });
  });

  it("uses the model override instead of GOOGLE_MODEL when given", () => {
    vi.stubEnv("GOOGLE_MODEL", "gemini-3.5-flash-lite");

    getModel("google", "gemini-2.5-pro");

    const modelFactory = createGoogleGenerativeAIMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("gemini-2.5-pro");
  });

  it("accepts a contextWindow for google without using it", () => {
    getModel("google", undefined, 1048576);

    const modelFactory = createGoogleGenerativeAIMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("gemini-3.6-flash");
  });

  it("resolves the Groq model without num_ctx", () => {
    getModel("groq");

    expect(createGroqMock).toHaveBeenCalledTimes(1);
    const modelFactory = createGroqMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("openai/gpt-oss-20b");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes GROQ_API_KEY to createGroq", () => {
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");

    getModel("groq");

    expect(createGroqMock).toHaveBeenCalledWith({ apiKey: "test-groq-key" });
  });

  it("uses the model override instead of GROQ_MODEL when given", () => {
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-120b");

    getModel("groq", "qwen/qwen3.6-27b");

    const modelFactory = createGroqMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("qwen/qwen3.6-27b");
  });

  it("accepts a contextWindow for groq without using it", () => {
    getModel("groq", undefined, 131072);

    const modelFactory = createGroqMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("openai/gpt-oss-20b");
  });

  it("resolves the OpenRouter model via createOpenRouter().chat, without num_ctx", () => {
    getModel("openrouter");

    expect(createOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(openRouterChatMock).toHaveBeenCalledWith("google/gemma-4-31b-it:free");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes OPENROUTER_API_KEY to createOpenRouter", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-or-key");

    getModel("openrouter");

    expect(createOpenRouterMock).toHaveBeenCalledWith({ apiKey: "test-or-key" });
  });

  it("uses the model override instead of OPENROUTER_MODEL when given", () => {
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");

    getModel("openrouter", "minimax/minimax-m3:free");

    expect(openRouterChatMock).toHaveBeenCalledWith("minimax/minimax-m3:free");
  });

  it("accepts a contextWindow for openrouter without using it", () => {
    getModel("openrouter", undefined, 262144);

    expect(openRouterChatMock).toHaveBeenCalledWith("google/gemma-4-31b-it:free");
  });

  it("resolves the Mistral model without num_ctx", () => {
    getModel("mistral");

    expect(createMistralMock).toHaveBeenCalledTimes(1);
    const modelFactory = createMistralMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("mistral-small-latest");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes MISTRAL_API_KEY to createMistral", () => {
    vi.stubEnv("MISTRAL_API_KEY", "test-mistral-key");

    getModel("mistral");

    expect(createMistralMock).toHaveBeenCalledWith({ apiKey: "test-mistral-key" });
  });

  it("uses the model override instead of MISTRAL_MODEL when given", () => {
    vi.stubEnv("MISTRAL_MODEL", "mistral-medium-latest");

    getModel("mistral", "ministral-8b-latest");

    const modelFactory = createMistralMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("ministral-8b-latest");
  });

  it("accepts a contextWindow for mistral without using it", () => {
    getModel("mistral", undefined, 131072);

    const modelFactory = createMistralMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("mistral-small-latest");
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
    expect(getModelName("openai")).toBe("gpt-4.1-nano");
    expect(getModelName("ollama")).toBe("llama3.2");
  });

  it("prefers the model override over the env var", () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");
    expect(getModelName("openai", "gpt-5-nano")).toBe("gpt-5-nano");
  });

  it("returns the configured Google model for the google provider", () => {
    vi.stubEnv("GOOGLE_MODEL", "gemini-3.5-flash-lite");
    expect(getModelName("google")).toBe("gemini-3.5-flash-lite");
  });

  it("falls back to the Google default when unset", () => {
    expect(getModelName("google")).toBe("gemini-3.6-flash");
  });

  it("prefers the model override over GOOGLE_MODEL", () => {
    vi.stubEnv("GOOGLE_MODEL", "gemini-3.5-flash-lite");
    expect(getModelName("google", "gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("returns the configured Groq model for the groq provider", () => {
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-120b");
    expect(getModelName("groq")).toBe("openai/gpt-oss-120b");
  });

  it("falls back to the Groq default when unset", () => {
    expect(getModelName("groq")).toBe("openai/gpt-oss-20b");
  });

  it("prefers the model override over GROQ_MODEL", () => {
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-120b");
    expect(getModelName("groq", "qwen/qwen3.6-27b")).toBe("qwen/qwen3.6-27b");
  });

  it("returns the configured OpenRouter model for the openrouter provider", () => {
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");
    expect(getModelName("openrouter")).toBe("z-ai/glm-5.2:free");
  });

  it("falls back to the OpenRouter default when unset", () => {
    expect(getModelName("openrouter")).toBe("google/gemma-4-31b-it:free");
  });

  it("prefers the model override over OPENROUTER_MODEL", () => {
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");
    expect(getModelName("openrouter", "minimax/minimax-m3:free")).toBe("minimax/minimax-m3:free");
  });

  it("returns the configured Mistral model for the mistral provider", () => {
    vi.stubEnv("MISTRAL_MODEL", "mistral-medium-latest");
    expect(getModelName("mistral")).toBe("mistral-medium-latest");
  });

  it("falls back to the Mistral default when unset", () => {
    expect(getModelName("mistral")).toBe("mistral-small-latest");
  });

  it("prefers the model override over MISTRAL_MODEL", () => {
    vi.stubEnv("MISTRAL_MODEL", "mistral-medium-latest");
    expect(getModelName("mistral", "ministral-8b-latest")).toBe("ministral-8b-latest");
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

  it("returns google when MODEL_PROVIDER is set to google", () => {
    vi.stubEnv("MODEL_PROVIDER", "google");
    expect(defaultProvider()).toBe("google");
  });

  it("returns openrouter when MODEL_PROVIDER is set to openrouter", () => {
    vi.stubEnv("MODEL_PROVIDER", "openrouter");
    expect(defaultProvider()).toBe("openrouter");
  });

  it("returns mistral when MODEL_PROVIDER is set to mistral", () => {
    vi.stubEnv("MODEL_PROVIDER", "mistral");
    expect(defaultProvider()).toBe("mistral");
  });
});

describe("effectiveContextWindow", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caps a large contextWindow at MODEL_CONTEXT_WINDOW for ollama", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "8192");
    expect(effectiveContextWindow("ollama", 131072)).toBe(8192);
  });

  it("passes a contextWindow through as-is for ollama when already below the ceiling", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "8192");
    expect(effectiveContextWindow("ollama", 4096)).toBe(4096);
  });

  it("falls back to the ceiling for ollama when no contextWindow is given", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "8192");
    expect(effectiveContextWindow("ollama")).toBe(8192);
  });

  it("never caps openai — returns the given contextWindow unchanged", () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "8192");
    expect(effectiveContextWindow("openai", 131072)).toBe(131072);
  });

  it("returns undefined for openai when no contextWindow is given", () => {
    expect(effectiveContextWindow("openai")).toBeUndefined();
  });

  it("never caps groq — returns the given contextWindow unchanged", () => {
    expect(effectiveContextWindow("groq", 131072)).toBe(131072);
  });

  it("never caps openrouter — returns the given contextWindow unchanged", () => {
    expect(effectiveContextWindow("openrouter", 262144)).toBe(262144);
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
