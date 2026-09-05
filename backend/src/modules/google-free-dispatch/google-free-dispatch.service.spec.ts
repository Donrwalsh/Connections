import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GoogleFreeDispatchService } from "./google-free-dispatch.service";
import { GoogleDispatchState } from "./entities/google-dispatch-state.entity";
import { GOOGLE_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";

const GOOGLE_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

describe("GoogleFreeDispatchService", () => {
  let service: GoogleFreeDispatchService;
  let mockStateRepo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockStrategyService: {
    countInFlightByModel: jest.Mock;
    countTodayDispatchByModel: jest.Mock;
    findUnrunPuzzleDatesForModel: jest.Mock;
    triggerStrategyRuns: jest.Mock;
  };
  let mockSupportedModelService: { findModelNamesByStrategy: jest.Mock };
  let mockHoldService: { heldModels: jest.Mock };

  const zeroCounts = () => new Map(GOOGLE_MODELS.map((model) => [model, 0]));

  beforeEach(async () => {
    mockStateRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockQueue = { add: jest.fn().mockResolvedValue(undefined) };
    mockStrategyService = {
      countInFlightByModel: jest.fn().mockResolvedValue(zeroCounts()),
      countTodayDispatchByModel: jest.fn().mockResolvedValue(zeroCounts()),
      findUnrunPuzzleDatesForModel: jest
        .fn()
        .mockResolvedValue([{ puzzleId: 1, date: "2024-01-01" }]),
      triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
    };
    mockSupportedModelService = {
      findModelNamesByStrategy: jest.fn().mockResolvedValue([...GOOGLE_MODELS]),
    };
    mockHoldService = { heldModels: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleFreeDispatchService,
        { provide: getRepositoryToken(GoogleDispatchState), useValue: mockStateRepo },
        { provide: GOOGLE_FREE_DISPATCH_QUEUE, useValue: mockQueue },
        { provide: StrategyService, useValue: mockStrategyService },
        { provide: SupportedModelService, useValue: mockSupportedModelService },
        { provide: RateLimitHoldService, useValue: mockHoldService },
      ],
    }).compile();

    service = module.get<GoogleFreeDispatchService>(GoogleFreeDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.FREE_TIER_DISPATCH_MAX_BATCH;
    delete process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT;
  });

  describe("start", () => {
    it("should reject starting a cycle that's already active", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });

      await expect(service.start()).rejects.toThrow(BadRequestException);
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should not start a cycle, and report alreadyExhausted, when every model is held", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "google",
        active: false,
        startedAt: null,
      });
      mockHoldService.heldModels.mockResolvedValueOnce([...GOOGLE_MODELS]);

      const result = await service.start();

      expect(result.outcome).toBe("alreadyExhausted");
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "google", active: false }),
      );
    });

    it("should start a cycle and queue the first tick when at least one model is free", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "google",
        active: true,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });
      mockHoldService.heldModels.mockResolvedValueOnce(["gemini-2.5-pro"]);

      const result = await service.start();

      expect(result.outcome).toBe("started");
      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "google", active: true }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({
          delay: 0,
          jobId: expect.stringContaining("google-free-dispatch-"),
        }),
      );
    });
  });

  describe("stop", () => {
    it("should deactivate the cycle and return its status", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: false, startedAt: null });

      const result = await service.stop();

      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
      expect(result.active).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should report inactive with null startedAt when no state row exists", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getStatus();

      expect(result).toEqual({ active: false, startedAt: null });
    });
  });

  describe("runTick", () => {
    it("should do nothing when the cycle is inactive", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      await service.runTick();

      expect(mockSupportedModelService.findModelNamesByStrategy).not.toHaveBeenCalled();
    });

    it("should stop when no Google models are configured", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockSupportedModelService.findModelNamesByStrategy.mockResolvedValueOnce([]);

      await service.runTick();

      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should stop once every model is RPD-held", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockHoldService.heldModels.mockResolvedValueOnce([...GOOGLE_MODELS]);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
    });

    it("should hold off dispatching, but keep ticking, once the in-flight backlog hits its cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "2";
      const inFlight = zeroCounts();
      inFlight.set("gemini-2.5-flash", 3);
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should dispatch only to eligible (non-held) models, least-allocated first", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockHoldService.heldModels.mockResolvedValueOnce(["gemini-2.5-flash"]);
      // The real call passes only eligibleModels (held models filtered out
      // before this lookup) — mock it the same way, or leastAllocatedModel
      // would see the held model too and could pick it on a tie.
      mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(
        new Map([["gemini-2.5-pro", 0]]),
      );
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([
        { puzzleId: 9, date: "2024-05-01" },
      ]);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledWith(
        9,
        "llm-google",
        "2024-05-01",
        "gemini-2.5-pro",
      );
    });

    it("should stop when every eligible model has run out of unrun puzzles", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
    });

    it("should treat a triggerStrategyRuns failure as that model unavailable this tick, not a hard failure", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockStrategyService.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

      await expect(service.runTick()).resolves.toBeUndefined();

      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
    });

    it("should schedule a further tick after a successful partial dispatch", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });
  });
});
