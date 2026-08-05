import { Test, TestingModule } from "@nestjs/testing";
import { AppService } from "./app.service";

describe("AppService", () => {
  let service: AppService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
    }).compile();

    service = module.get<AppService>(AppService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const mockResponse = (
    status: number,
    statusText: string,
    body: unknown,
  ): Response =>
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
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse(200, "OK", body));

      const result = await service.solve(["A", "B", "C", "D"], [
        { words: ["A"], result: "incorrect" },
      ]);

      expect(result).toEqual({ orchestrator: "healthy", data: body });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://ai_orchestrator:3001/solve",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "x-internal-api-key": "potato",
          }),
          body: JSON.stringify({
            puzzleWords: ["A", "B", "C", "D"],
            priorGuesses: [{ words: ["A"], result: "incorrect" }],
          }),
        }),
      );
    });

    it("should default priorGuesses to an empty array", async () => {
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse(200, "OK", body));

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

    it("should report unhealthy with the HTTP status on a non-2xx response", async () => {
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse(503, "Service Unavailable", {}));

      const result = await service.solve(["A", "B", "C", "D"]);

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "HTTP 503 Service Unavailable",
      });
    });

    it("should report unhealthy with the error message on a network failure", async () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await service.solve(["A", "B", "C", "D"]);

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "ECONNREFUSED",
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("should report 'Unknown error' when the thrown value is not an Error", async () => {
      fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue("boom");

      const result = await service.solve(["A", "B", "C", "D"]);

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "Unknown error",
      });
    });

    it("should report 'Request timed out' when the request is aborted", async () => {
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

      const resultPromise = service.solve(["A", "B", "C", "D"]);
      await jest.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result).toEqual({
        orchestrator: "unhealthy",
        error: "Request timed out",
      });
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
      fetchSpy = jest
        .spyOn(global, "fetch")
        .mockRejectedValue(new Error("boom"));

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
});
