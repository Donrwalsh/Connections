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
    // Don't actually sleep between retries in tests.
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = jest.fn();
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    delete process.env.ORCHESTRATOR_URL;
    jest.restoreAllMocks();
  });

  it("should return the solve-assist data on a 200", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({ ok: true, data: successBody });
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
      data: { response: "text", groups: [], model: "mistral", latencyMs: 0, usage: undefined },
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
      error: { error: "malformed", code: "invalid_group" },
    });
  });

  it("should retry 5xx responses and succeed on a later attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          body: { error: "model down", code: "model_error" },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({ ok: true, data: successBody });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should give up with model_error after repeated 5xx responses", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        body: { error: "model down", code: "model_error" },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "model_error" },
    });
  });

  it("should give up with model_error after network failures", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const outcome = await service.solveAssist(messages);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "model_error" },
    });
    if (!outcome.ok) {
      expect(outcome.error.error).toContain("ECONNREFUSED");
    }
  });

  it("should not retry after a request times out", async () => {
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValue(abortError);

    const outcome = await service.solveAssist(messages);

    // A timeout means the orchestrator is likely still working on the
    // aborted request, so retrying would just queue behind it. The strategy
    // worker re-runs the step on its own backoff schedule instead.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ok: false,
      error: { error: "Request timed out", code: "model_error" },
    });
  });
});
