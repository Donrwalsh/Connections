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
