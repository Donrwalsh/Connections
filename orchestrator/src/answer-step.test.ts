import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnswerStep } from "./answer-step.js";

describe("runAnswerStep", () => {
  const generateTextMock = vi.hoisted(() => vi.fn());
  const getModelSpy = vi.hoisted(() => vi.fn());

  vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();
    return { ...actual, generateText: generateTextMock };
  });

  vi.mock("./provider.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./provider.js")>();
    return {
      ...actual,
      getModel: (...args: Parameters<typeof actual.getModel>) => {
        getModelSpy(...args);
        return actual.getModel(...args);
      },
    };
  });

  const MESSAGES = [{ role: "user" as const, content: "solve this puzzle" }];

  beforeEach(() => {
    generateTextMock.mockReset();
    getModelSpy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("captures the raw request/response detail on a successful call by default", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: {
        modelId: "gpt-4.1-nano",
        id: "resp_123",
        headers: { "x-request-id": "req_123" },
        body: { id: "resp_123", choices: [{ message: { content: "### ANSWER..." } }] },
      },
      request: {
        body: { model: "gpt-4.1-nano", messages: [{ role: "user", content: "solve this puzzle" }] },
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const controller = new AbortController();
    const result = await runAnswerStep(MESSAGES, { abortSignal: controller.signal });

    // The mock ignores `include`/`abortSignal`, so this only guards against
    // the options being dropped — the real AI SDK gates request/response
    // body behind `include` (default false) and would silently leave both
    // undefined without it, and would never see a client's abort without
    // `abortSignal`, running (and billing) the call to completion instead.
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
        include: { requestBody: true, responseBody: true },
        abortSignal: controller.signal,
      }),
    );
    expect(result.requestBody).toEqual({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "solve this puzzle" }],
    });
    expect(result.responseId).toBe("resp_123");
    expect(result.responseHeaders).toEqual({ "x-request-id": "req_123" });
    expect(result.responseBody).toEqual({
      id: "resp_123",
      choices: [{ message: { content: "### ANSWER..." } }],
    });
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  it("skips requesting request/response body detail entirely when captureTelemetry is false", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: { modelId: "test-model" },
      request: {},
    });

    const result = await runAnswerStep(MESSAGES, { captureTelemetry: false });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ include: expect.anything() }),
    );
    expect(result.requestBody).toBeUndefined();
    expect(result.responseId).toBeUndefined();
    expect(result.responseHeaders).toBeUndefined();
    expect(result.responseBody).toBeUndefined();
    expect(result.latencyMs).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it("disables the AI SDK's own retry layer (maxRetries: 0)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: { modelId: "gpt-4.1-nano" },
      request: {},
    });

    await runAnswerStep(MESSAGES);

    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });

  it("passes contextWindow through to getModel", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: { modelId: "mistral-nemo" },
      request: {},
    });

    await runAnswerStep(MESSAGES, { model: "mistral-nemo", provider: "ollama", contextWindow: 131072 });

    expect(getModelSpy).toHaveBeenCalledWith("ollama", "mistral-nemo", 131072);
  });

  it("reports the effective (capped) contextWindow in the result, not the requested one", async () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "8192");
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: { modelId: "mistral-nemo" },
      request: {},
    });

    const result = await runAnswerStep(MESSAGES, {
      model: "mistral-nemo",
      provider: "ollama",
      contextWindow: 131072,
    });

    expect(result.contextWindow).toBe(8192);
  });

  it("reports contextWindow unchanged for openai (no cap concept)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: { modelId: "gpt-4.1-nano" },
      request: {},
    });

    const result = await runAnswerStep(MESSAGES, {
      model: "gpt-4.1-nano",
      provider: "openai",
      contextWindow: 128000,
    });

    expect(result.contextWindow).toBe(128000);
  });

  it("returns the full structured parse alongside the raw response", async () => {
    generateTextMock.mockResolvedValueOnce({
      text:
        "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
        "### ANSWER\nAPPLE, BANANA, CHERRY, DATE",
      response: { modelId: "gpt-4.1-nano" },
      request: {},
    });

    const result = await runAnswerStep(MESSAGES);

    expect(result.groups).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.proposalWords).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.categoryByGroup).toEqual({ "1": "Fruits" });
    expect(result.textIssues).toEqual([]);
  });

  it("rejects a response with no parseable ANSWER or GROUPS section as invalid_group", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "I don't know the answer",
      response: { modelId: "test-model" },
      request: {},
    });

    await expect(runAnswerStep(MESSAGES)).rejects.toMatchObject({ code: "invalid_group" });
  });

  it("surfaces APICallError detail instead of discarding it", async () => {
    const { APICallError } = await import("ai");
    generateTextMock.mockRejectedValueOnce(
      new APICallError({
        message: "Rate limit exceeded",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: { model: "gpt-4.1-nano" },
        statusCode: 429,
        responseHeaders: { "retry-after": "30" },
        responseBody: '{"error":{"message":"Rate limit exceeded"}}',
        isRetryable: true,
      }),
    );

    await expect(runAnswerStep(MESSAGES)).rejects.toMatchObject({
      code: "model_error",
      details: {
        requestBody: { model: "gpt-4.1-nano" },
        statusCode: 429,
        responseHeaders: { "retry-after": "30" },
        responseBody: '{"error":{"message":"Rate limit exceeded"}}',
        isRetryable: true,
        errorName: "AI_APICallError",
      },
    });
  });

  it("still classifies a plain non-API error as model_error with no call detail", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(runAnswerStep(MESSAGES)).rejects.toMatchObject({
      code: "model_error",
      details: { requestBody: undefined, statusCode: undefined },
    });
  });
});
