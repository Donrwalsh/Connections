import { Agent } from "undici";
import { OrchestratorService, type ChatMessage } from "./orchestrator.service";

describe("OrchestratorService", () => {
  let service: OrchestratorService;
  let mockFetch: jest.Mock;

  const messages: ChatMessage[] = [{ role: "user", content: "solve this puzzle" }];

  const successBody = {
    response: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
    groups: [["AAAA", "BBBB", "CCCC", "DDDD"]],
    model: "mistral",
    latencyMs: 5,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  };

  const mockResponse = (init: {
    ok: boolean;
    status: number;
    statusText?: string;
    body: unknown;
  }) =>
    ({
      ok: init.ok,
      status: init.status,
      statusText: init.statusText ?? "",
      json: async () => init.body,
    }) as Response;

  beforeEach(() => {
    process.env.INTERNAL_API_KEY = "test-key";
    process.env.ORCHESTRATOR_URL = "http://orchestrator.test";
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    service = new OrchestratorService();
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    delete process.env.ORCHESTRATOR_URL;
    jest.restoreAllMocks();
  });

  it("should return the solve-assist data on a 200", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: true,
      data: {
        ...successBody,
        requestBody: undefined,
        responseId: undefined,
        responseHeaders: undefined,
        responseBody: undefined,
      },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-internal-api-key": "test-key",
        }),
        body: JSON.stringify({ messages }),
      }),
    );
  });

  it("should report the effective contextWindow from the orchestrator's response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { ...successBody, contextWindow: 8192 } }),
    );

    const outcome = await service.solveAssist(messages, "mistral-nemo", "ollama", 131072);

    expect(outcome).toEqual({
      ok: true,
      data: expect.objectContaining({ contextWindow: 8192 }),
    });
  });

  it("should include contextWindow in the request body when given", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages, "mistral-nemo", "ollama", 131072);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        body: JSON.stringify({
          messages,
          model: "mistral-nemo",
          provider: "ollama",
          contextWindow: 131072,
        }),
      }),
    );
  });

  it("should include the model and provider in the request body when given", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages, "gpt-4.1-nano-2025-04-14", "openai");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        body: JSON.stringify({
          messages,
          model: "gpt-4.1-nano-2025-04-14",
          provider: "openai",
        }),
      }),
    );
  });

  it("should include the google provider in the request body when given", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages, "gemini-3.6-flash", "google");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        body: JSON.stringify({
          messages,
          model: "gemini-3.6-flash",
          provider: "google",
        }),
      }),
    );
  });

  it("should include the openrouter provider in the request body when given", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages, "z-ai/glm-5.2:free", "openrouter");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        body: JSON.stringify({
          messages,
          model: "z-ai/glm-5.2:free",
          provider: "openrouter",
        }),
      }),
    );
  });

  it("should include the mistral provider in the request body when given", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages, "mistral-small-latest", "mistral");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        body: JSON.stringify({
          messages,
          model: "mistral-small-latest",
          provider: "mistral",
        }),
      }),
    );
  });

  it("should include the sambanova provider in the request body when given", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages, "DeepSeek-V3.1", "sambanova");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        body: JSON.stringify({
          messages,
          model: "DeepSeek-V3.1",
          provider: "sambanova",
        }),
      }),
    );
  });

  it("passes an undici dispatcher so undici's own header/body timeouts don't preempt ORCHESTRATOR_TIMEOUT_MS", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages);

    const init = mockFetch.mock.calls[0][1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeInstanceOf(Agent);
  });

  it("should extract dailyResetSeconds from a SambaNova rate_limited_daily failure", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: {
          error: "SambaNova daily quota exhausted",
          code: "rate_limited_daily",
          details: { dailyResetSeconds: 7200 },
        },
      }),
    );

    const outcome = await service.solveAssist(messages, "DeepSeek-V3.1", "sambanova");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("rate_limited_daily");
      expect(outcome.error.dailyResetSeconds).toBe(7200);
    }
  });

  it("should extract dailyResetSeconds from an OpenRouter rate_limited_daily failure", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: {
          error: "OpenRouter daily quota exhausted",
          code: "rate_limited_daily",
          details: { dailyResetSeconds: 7200 },
        },
      }),
    );

    const outcome = await service.solveAssist(messages, "z-ai/glm-5.2:free", "openrouter");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("rate_limited_daily");
      expect(outcome.error.dailyResetSeconds).toBe(7200);
    }
  });

  it("should extract retryAfterSeconds from a rate_limited failure", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: {
          error: "Google rate limit hit",
          code: "rate_limited",
          details: { retryAfterSeconds: 3.86 },
        },
      }),
    );

    const outcome = await service.solveAssist(messages, "gemini-3.6-flash", "google");

    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "rate_limited",
        retryAfterSeconds: 3.86,
        statusCode: 429,
      }),
    });
  });

  it("should extract dailyResetSeconds from a Groq rate_limited_daily failure", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: {
          error: "Groq daily quota exhausted",
          code: "rate_limited_daily",
          details: { dailyResetSeconds: 3600 },
        },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "rate_limited_daily",
        dailyResetSeconds: 3600,
        statusCode: 429,
      }),
    });
  });

  it("should pass rate_limited_daily through instead of coercing it to model_error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: {
          error: "Google daily quota exhausted",
          code: "rate_limited_daily",
          details: {},
        },
      }),
    );

    const outcome = await service.solveAssist(
      [{ role: "user", content: "hi" }],
      "gemini-3.6-flash",
      "google",
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("rate_limited_daily");
    }
  });

  it("should default latencyMs to 0 when the orchestrator omits it", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { response: "text", groups: [], model: "mistral" },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: true,
      data: {
        response: "text",
        groups: [],
        model: "mistral",
        latencyMs: 0,
        usage: undefined,
        requestBody: undefined,
        responseId: undefined,
        responseHeaders: undefined,
        responseBody: undefined,
      },
    });
  });

  it("should surface an invalid_group response as a non-ok outcome", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: { error: "malformed", code: "invalid_group" },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: false,
      error: {
        error: "malformed",
        code: "invalid_group",
        statusCode: 400,
      },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should classify a 5xx response as model_error with no retry", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        body: { error: "model down", code: "model_error" },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ok: false,
      error: {
        error: "model down",
        code: "model_error",
        statusCode: 502,
      },
    });
  });

  it("should classify a network failure as model_error with no retry", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const outcome = await service.solveAssist(messages);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "model_error" },
    });
    if (!outcome.ok) {
      expect(outcome.error.error).toContain("ECONNREFUSED");
    }
  });

  it("should unwrap the undici cause behind a bare 'fetch failed'", async () => {
    // What Node's global fetch actually throws when the connection drops:
    // a TypeError whose message is only "fetch failed", with the real
    // failure on .cause.
    const fetchFailed = new TypeError("fetch failed");
    (fetchFailed as { cause?: unknown }).cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    mockFetch.mockRejectedValueOnce(fetchFailed);

    const outcome = await service.solveAssist(messages);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ok: false,
      error: {
        error: "fetch failed (ECONNRESET: read ECONNRESET)",
        code: "model_error",
        errorName: "ECONNRESET",
      },
    });
  });

  it("should unwrap an AggregateError cause (multiple failed connect attempts)", async () => {
    const fetchFailed = new TypeError("fetch failed");
    (fetchFailed as { cause?: unknown }).cause = new AggregateError([
      Object.assign(new Error("connect ECONNREFUSED ::1:3001"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:3001"), { code: "ETIMEDOUT" }),
    ]);
    mockFetch.mockRejectedValueOnce(fetchFailed);

    const outcome = await service.solveAssist(messages);

    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.error.error).toContain("ECONNREFUSED");
    expect(outcome.error.error).toContain("ETIMEDOUT");
    expect(outcome.error.errorName).toBe("ECONNREFUSED");
  });

  it("should classify a timeout as model_error with no retry", async () => {
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortError);

    const outcome = await service.solveAssist(messages);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ok: false,
      error: { error: "Request timed out", code: "model_error", errorName: "AbortError" },
    });
  });

  it("should include the raw request/response detail on a 200", async () => {
    const successBodyWithDetail = {
      ...successBody,
      requestBody: { model: "gpt-4.1-nano", messages },
      responseId: "resp_123",
      responseHeaders: { "x-request-id": "req_123" },
      responseBody: { id: "resp_123", choices: [] },
    };
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: successBodyWithDetail }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({ ok: true, data: successBodyWithDetail });
  });

  it("should surface the raw call detail from a terminal error's details bag", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: {
          error: "malformed",
          code: "invalid_group",
          details: {
            requestBody: { model: "gpt-4.1-nano" },
            responseId: "resp_456",
            responseHeaders: { "x-request-id": "req_456" },
            responseBody: { id: "resp_456", choices: [] },
          },
        },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: false,
      error: {
        error: "malformed",
        code: "invalid_group",
        requestBody: { model: "gpt-4.1-nano" },
        responseId: "resp_456",
        responseHeaders: { "x-request-id": "req_456" },
        responseBody: { id: "resp_456", choices: [] },
        statusCode: 400,
      },
    });
  });

  it("should preserve the real HTTP status when the details bag has no statusCode of its own", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        body: {
          error: "model down",
          code: "model_error",
          // details is present (so extractCallDetail returns a real object,
          // its own statusCode key just undefined) — this is the case that
          // used to clobber response.status with undefined.
          details: { errorName: "FetchError", isRetryable: true },
        },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: false,
      error: {
        error: "model down",
        code: "model_error",
        statusCode: 502,
        errorName: "FetchError",
        isRetryable: true,
      },
    });
  });

  describe("judgeCategory", () => {
    it("POSTs categories to /judge-category and maps the success body", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            verdict: "lucky",
            rationale: "Right words, wrong reason.",
            model: "gpt-4.1-nano",
            latencyMs: 42,
            usage: { promptTokens: 100, completionTokens: 12, totalTokens: 112 },
            requestBody: { a: 1 },
            responseId: "r1",
            responseHeaders: { h: "v" },
            responseBody: { ok: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const outcome = await service.judgeCategory("Fruits", "___ COBBLER", "gpt-4.1-nano", "openai");

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/judge-category"),
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({
        proposedCategory: "Fruits",
        actualCategory: "___ COBBLER",
        model: "gpt-4.1-nano",
        provider: "openai",
      });
      expect(outcome).toEqual({
        ok: true,
        data: expect.objectContaining({ verdict: "lucky", rationale: "Right words, wrong reason." }),
      });
    });

    it("returns { ok: false } with the failure detail on a non-2xx response", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: "boom", code: "model_error" }), { status: 502 }),
      );
      const outcome = await service.judgeCategory("A", "B", "gpt-4.1-nano", "openai");
      expect(outcome.ok).toBe(false);
    });
  });
});
