import { Test, TestingModule } from "@nestjs/testing";
import { getDataSourceToken } from "@nestjs/typeorm";
import { Logger } from "@nestjs/common";
import { AppService } from "./app.service";

describe("AppService", () => {
  let service: AppService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    process.env.INTERNAL_API_KEY = "test-key";

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
        {
          provide: getDataSourceToken(),
          useValue: { query: jest.fn().mockResolvedValue([{ "?column?": 1 }]) },
        },
      ],
    }).compile();

    service = module.get<AppService>(AppService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const mockResponse = (status: number, statusText: string, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: jest.fn().mockResolvedValue(body),
    }) as unknown as Response;

  describe("solve", () => {
    const body = {
      proposedGroup: {
        word_ids: [0, 1, 2, 3],
        category: "Things",
        confidence: 0.95,
        reasoning: "all start with A",
      },
      prompt: "pick a group",
    };

    it("should return healthy with parsed data on a 2xx response", async () => {
      fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse(200, "OK", body));

      const result = await service.solve(
        ["A", "B", "C", "D"],
        [{ words: ["A"], result: "incorrect" }],
      );

      expect(result).toEqual({ orchestrator: "healthy", data: body });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://ai_orchestrator:3001/solve",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "x-internal-api-key": "test-key",
          }),
          body: JSON.stringify({
            puzzleWords: ["A", "B", "C", "D"],
            priorGuesses: [{ words: ["A"], result: "incorrect" }],
          }),
        }),
      );
    });

    it("should default priorGuesses to an empty array", async () => {
      fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse(200, "OK", body));

      await service.solve(["A", "B", "C", "D"]);

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://ai_orchestrator:3001/solve",
        expect.objectContaining({
          body: JSON.stringify({
            puzzleWords: ["A", "B", "C", "D"],
            priorGuesses: [],
          }),
        }),
      );
    });

    it("should report the retry failure with the HTTP status on a non-2xx response", async () => {
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse(503, "Service Unavailable", {}));

      const result = await service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 0,
      });

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "AI solve request failed after 1 attempt: HTTP 503 Service Unavailable",
      });
    });

    it("should report the retry failure message on a network failure", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 0,
      });

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "AI solve request failed after 1 attempt: ECONNREFUSED",
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("should wrap a non-Error fetch failure into the retry failure message", async () => {
      fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue("boom");

      const result = await service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 0,
      });

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "AI solve request failed after 1 attempt: boom",
      });
    });

    it("should report 'Unknown error' when a non-Error is thrown outside the fetch", async () => {
      fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: jest.fn().mockRejectedValue("boom"),
      } as unknown as Response);

      const result = await service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 0,
      });

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "Unknown error",
      });
    });

    it("should report 'Request timed out' when a single attempt is aborted", async () => {
      jest.useFakeTimers();
      jest.spyOn(console, "log").mockImplementation(() => {});
      fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as { signal: AbortSignal }).signal;
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );

      const resultPromise = service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 0,
        timeoutMs: 5000,
      });
      await jest.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "AI solve request failed after 1 attempt: Request timed out",
      });
    });

    it("should retry with exponential backoff and succeed", async () => {
      jest.useFakeTimers();
      const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(mockResponse(200, "OK", body));

      const resultPromise = service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 3,
        initialDelayMs: 1000,
      });

      await jest.advanceTimersByTimeAsync(10000);

      const result = await resultPromise;

      expect(result).toEqual({ orchestrator: "healthy", data: body });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("attempt 1 of 4"));
      expect(warnSpy).toHaveBeenNthCalledWith(1, expect.stringContaining("Retrying in 1000ms"));
      expect(warnSpy).toHaveBeenNthCalledWith(2, expect.stringContaining("Retrying in 2000ms"));
    });

    it("should retry on non-2xx responses and succeed", async () => {
      jest.useFakeTimers();
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(mockResponse(500, "Internal Server Error", {}))
        .mockResolvedValueOnce(mockResponse(200, "OK", body));

      const resultPromise = service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 3,
        initialDelayMs: 1000,
      });

      await jest.advanceTimersByTimeAsync(10000);

      const result = await resultPromise;

      expect(result).toEqual({ orchestrator: "healthy", data: body });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("should fail after all retries are exhausted with attempt count and last error", async () => {
      jest.useFakeTimers();
      jest.spyOn(console, "warn").mockImplementation(() => {});
      fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      const resultPromise = service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 2,
        initialDelayMs: 1000,
      });

      await jest.advanceTimersByTimeAsync(10000);

      const result = await resultPromise;

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "AI solve request failed after 3 attempts: ECONNREFUSED",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("should not retry after a request times out", async () => {
      jest.useFakeTimers();
      jest.spyOn(console, "warn").mockImplementation(() => {});
      fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as { signal: AbortSignal }).signal;
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );

      const resultPromise = service.solve(["A", "B", "C", "D"], [], {
        maxRetries: 1,
        timeoutMs: 5000,
      });

      await jest.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      // A timeout means the step exceeded its budget (a solve step runs up to
      // LLM_MAX_PROMPTS sequential model calls). The orchestrator is likely
      // still working on the aborted request, so retrying would just queue
      // behind it — fail after the single attempt instead.
      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "AI solve request failed after 1 attempt: Request timed out",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("checkOrchestrator", () => {
    it("should return healthy with parsed data on a 2xx response", async () => {
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse(200, "OK", { status: "ok" }));

      const result = await service.checkOrchestrator();

      expect(result).toEqual({ orchestrator: "healthy", data: { status: "ok" } });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://ai_orchestrator:3001/health",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("should report unhealthy with the HTTP status on a non-2xx response", async () => {
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse(500, "Internal Server Error", {}));

      const result = await service.checkOrchestrator();

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "HTTP 500 Internal Server Error",
      });
    });

    it("should report unhealthy with a stringified error on failure", async () => {
      fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("boom"));

      const result = await service.checkOrchestrator();

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "Error: boom",
      });
    });

    it("should report unhealthy when the request times out", async () => {
      jest.useFakeTimers();
      fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as { signal: AbortSignal }).signal;
            signal.addEventListener("abort", () => reject(new Error("Aborted")));
          }),
      );

      const resultPromise = service.checkOrchestrator();
      await jest.advanceTimersByTimeAsync(3000);
      const result = await resultPromise;

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "Error: Aborted",
      });
    });
  });

  describe("checkHealth", () => {
    it("should report ok when the database responds", async () => {
      await expect(service.checkHealth()).resolves.toEqual({
        status: "ok",
        db: "up",
      });
    });

    it("should report degraded when the database is unreachable", async () => {
      const module = await Test.createTestingModule({
        providers: [
          AppService,
          {
            provide: getDataSourceToken(),
            useValue: {
              query: jest.fn().mockRejectedValue(new Error("connection refused")),
            },
          },
        ],
      }).compile();
      const degraded = module.get<AppService>(AppService);

      await expect(degraded.checkHealth()).resolves.toEqual({
        status: "degraded",
        db: "down",
      });
    });
  });

  describe("diagnose", () => {
    const messages = [
      {
        role: "user" as const,
        content: "You are playing NYT Connections. The items below form 2 groups of four...",
      },
    ];

    it("should return healthy with the model answer on a 2xx response", async () => {
      const body = {
        response: "Reasoning.\nANSWER:\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
        groups: [
          ["AAAA", "BBBB", "CCCC", "DDDD"],
          ["EEEE", "FFFF", "GGGG", "HHHH"],
        ],
        model: "test-model",
      };
      fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse(200, "OK", body));

      const result = await service.diagnose(messages);

      expect(result).toEqual({ orchestrator: "healthy", data: body });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://ai_orchestrator:3001/diagnose",
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

    it("should surface the orchestrator's error message on a non-2xx response", async () => {
      fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
        mockResponse(400, "Bad Request", {
          error: 'Model response contained no "ANSWER:" section with group lines',
        }),
      );

      const result = await service.diagnose(messages);

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: 'Model response contained no "ANSWER:" section with group lines',
      });
    });

    it("should fall back to the HTTP status when the error body has no message", async () => {
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse(502, "Bad Gateway", {}));

      const result = await service.diagnose(messages);

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "HTTP 502 Bad Gateway",
      });
    });

    it("should report the failure message on a network error", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await service.diagnose(messages);

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "ECONNREFUSED",
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
    });
  });
});
