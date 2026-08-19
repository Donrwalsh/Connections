import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierDispatchService } from "./free-tier-dispatch.service";
import { FreeTierDispatchState } from "./entities/free-tier-dispatch-state.entity";
import { FREE_TIER_DISPATCH_QUEUE } from "../queue/queue.module";
import { StrategyService } from "../strategy/strategy.service";
import {
  FreeTierId,
  FreeTierUsageService,
  MINI_FREE_TIER,
  FLAGSHIP_FREE_TIER,
} from "../strategy/free-tier-usage.service";

describe("FreeTierDispatchService", () => {
  let service: FreeTierDispatchService;
  let mockStateRepo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockStrategyService: {
    countInFlightByModel: jest.Mock;
    countTodayDispatchByModel: jest.Mock;
    findUnrunPuzzleDatesForModel: jest.Mock;
    triggerStrategyRuns: jest.Mock;
  };
  let mockFreeTierUsageService: { getUsage: jest.Mock };

  const zeroCounts = (tier: FreeTierId = "mini") => {
    const models = tier === "mini" ? MINI_FREE_TIER.models : FLAGSHIP_FREE_TIER.models;
    return new Map(models.map((model) => [model, 0]));
  };

  // Default usage stub for a tier: zero spend, full budget remaining. Tests
  // override with mockResolvedValueOnce for the specific numbers they need.
  const usageStub = (tier: FreeTierId, overrides: Record<string, unknown> = {}) => {
    const program = tier === "mini" ? MINI_FREE_TIER : FLAGSHIP_FREE_TIER;
    return {
      tier,
      label: program.label,
      usedTokens: 0,
      dailyLimitTokens: program.dailyLimitTokens,
      remainingTokens: program.dailyLimitTokens,
      models: [...program.models],
      ...overrides,
    };
  };

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
      findUnrunPuzzleDatesForModel: jest.fn().mockResolvedValue([{ puzzleId: 1, date: "2024-01-01" }]),
      triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
    };
    mockFreeTierUsageService = {
      getUsage: jest.fn().mockImplementation(async (tier: FreeTierId) => usageStub(tier)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreeTierDispatchService,
        { provide: getRepositoryToken(FreeTierDispatchState), useValue: mockStateRepo },
        { provide: FREE_TIER_DISPATCH_QUEUE, useValue: mockQueue },
        { provide: StrategyService, useValue: mockStrategyService },
        { provide: FreeTierUsageService, useValue: mockFreeTierUsageService },
      ],
    }).compile();

    service = module.get<FreeTierDispatchService>(FreeTierDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.FREE_TIER_DISPATCH_MAX_BATCH;
    delete process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT;
    delete process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE;
    delete process.env.FREE_TIER_DISPATCH_TICK_MS;
  });

  describe("start", () => {
    it("should reject a tier that isn't a real free-tier program", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.start("bogus" as FreeTierId, 90)).rejects.toThrow(BadRequestException);
      expect(mockStateRepo.save).not.toHaveBeenCalled();
    });

    it("should reject a non-integer threshold", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.start("mini", 87.5)).rejects.toThrow(BadRequestException);
    });

    it("should reject a threshold of 0 or below", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.start("mini", 0)).rejects.toThrow(BadRequestException);
    });

    it("should reject a threshold above 100", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.start("mini", 101)).rejects.toThrow(BadRequestException);
    });

    it("should reject starting a cycle that's already active", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 80,
      });

      await expect(service.start("mini", 90)).rejects.toThrow(
        new BadRequestException(
          "Free-tier dispatch for 'mini' is already running at a 80% threshold. Stop it first to change the threshold.",
        ),
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should save active state and enqueue the first tick with no delay", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 90,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const result = await service.start("mini", 90);

      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "mini", active: true, thresholdPercent: 90 }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: 0, jobId: expect.stringContaining("free-tier-dispatch-mini-") }),
      );
      expect(result.active).toBe(true);
      expect(result.thresholdPercent).toBe(90);
    });

    it("should start a flagship cycle the same way as mini", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        tier: "flagship",
        active: true,
        thresholdPercent: 75,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const result = await service.start("flagship", 75);

      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "flagship", active: true, thresholdPercent: 75 }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "flagship" },
        expect.objectContaining({ jobId: expect.stringContaining("free-tier-dispatch-flagship-") }),
      );
      expect(result).toEqual(
        expect.objectContaining({ tier: "flagship", active: true, thresholdPercent: 75 }),
      );
    });

    it("should track flagship and mini as independent cycles — starting one doesn't touch the other", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null); // no existing mini cycle

      await service.start("mini", 90);

      // The "already running" check only looked at 'mini's own row.
      expect(mockStateRepo.findOne).toHaveBeenCalledWith({ where: { tier: "mini" } });
      expect(mockStateRepo.findOne).not.toHaveBeenCalledWith({ where: { tier: "flagship" } });
    });

    it("should give each start() call a distinct job id, even for the same tier", async () => {
      mockStateRepo.findOne.mockResolvedValue(null);

      await service.start("mini", 90);
      await service.stop("mini");
      await service.start("mini", 80);

      const jobIds = mockQueue.add.mock.calls.map((call) => call[2].jobId);
      expect(new Set(jobIds).size).toBe(jobIds.length);
    });
  });

  describe("stop", () => {
    it("should deactivate the tier and return its status", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({
        tier: "mini",
        active: false,
        thresholdPercent: 90,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const result = await service.stop("mini");

      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(result.active).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should report inactive with null threshold when no state row exists", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getStatus("mini");

      expect(result).toEqual({ tier: "mini", active: false, thresholdPercent: null, startedAt: null });
    });

    it("should report the stored state when a row exists", async () => {
      const startedAt = new Date("2024-01-01T00:00:00Z");
      mockStateRepo.findOne.mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 85,
        startedAt,
      });

      const result = await service.getStatus("mini");

      expect(result).toEqual({ tier: "mini", active: true, thresholdPercent: 85, startedAt });
    });
  });

  describe("runTick", () => {
    it("should do nothing when the tier has no active state", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      await service.runTick("mini");

      expect(mockFreeTierUsageService.getUsage).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should do nothing when the tier's state row is present but inactive", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: false, thresholdPercent: 90 });

      await service.runTick("mini");

      expect(mockFreeTierUsageService.getUsage).not.toHaveBeenCalled();
    });

    it("should stop the cycle once usage reaches the threshold", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 10 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(
        usageStub("mini", { usedTokens: 250_001 }), // 10% of 2.5M is 250,000
      );

      await service.runTick("mini");

      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should hold off on new dispatches, but keep ticking, once the in-flight backlog hits its cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "2";
      // 3 trials already in flight exceeds the cap of 2 set above, on its
      // own, regardless of token budget.
      const inFlight = zeroCounts();
      inFlight.set("gpt-4.1-nano", 3);
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStrategyService.countTodayDispatchByModel).not.toHaveBeenCalled();
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should dispatch only enough to fill the remaining in-flight headroom, not the full batch cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "5";
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "3";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1"; // budget is never the limiting factor here
      const inFlight = zeroCounts();
      inFlight.set("gpt-4.1-nano", 2); // cap is 3, so only 1 more trial has headroom
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
    });

    it("should hold off on new dispatches, but keep ticking, when the token budget is nearly spoken for", async () => {
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "4000";
      // Raise the in-flight cap so this test exercises the token-budget
      // check specifically, not the (lower-priority) in-flight cap above.
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "1000";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      // thresholdTokens = 2,250,000; remainingBudget = 2,250,000. With 900
      // trials in flight (100 per model) at the 4000-token estimate, that's
      // 3,600,000 reserved — already well over budget on its own.
      const heavyInFlight = new Map(MINI_FREE_TIER.models.map((model) => [model, 100]));
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(heavyInFlight);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should dispatch to the least-allocated models first, up to the batch cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "2";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1"; // budget is never the limiting factor here
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      // Every model starts well-represented except two, which are the only
      // ones that should receive this tick's dispatches.
      const allocation = new Map(MINI_FREE_TIER.models.map((model) => [model, 5]));
      allocation.set("o4-mini", 0);
      allocation.set("o3-mini", 0);
      mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([
        { puzzleId: 42, date: "2024-06-01" },
      ]);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(2);
      const dispatchedModels = mockStrategyService.triggerStrategyRuns.mock.calls.map((call) => call[3]);
      expect(new Set(dispatchedModels)).toEqual(new Set(["o4-mini", "o3-mini"]));
    });

    it("should schedule a further tick after a successful partial dispatch", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should skip a model with no unrun puzzles left and try the next one", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      const allocation = zeroCounts();
      mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
      // Every model ties at 0, so iteration order decides who's tried
      // first — exhaust all of them except the last so the loop is forced
      // to fall through to a model that actually has a puzzle.
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);
      mockStrategyService.findUnrunPuzzleDatesForModel.mockImplementation(async (_s, model: string) =>
        model === "gpt-5-nano" ? [{ puzzleId: 1, date: "2024-01-01" }] : [],
      );

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledWith(
        1,
        "llm-openai",
        "2024-01-01",
        "gpt-5-nano",
      );
    });

    it("should stop the cycle when every model has run out of unrun puzzles", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should treat a triggerStrategyRuns failure as that model being unavailable this tick, not a hard failure", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

      await expect(service.runTick("mini")).resolves.toBeUndefined();

      // Every model was tried and failed the same way -> cycle stops rather
      // than looping forever.
      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
    });

    describe("flagship tier", () => {
      it("should look up usage and budget for flagship, not mini", async () => {
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 10,
        });
        // 10% of flagship's 250,000 budget is 25,000 — already reached.
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(
          usageStub("flagship", { usedTokens: 25_000 }),
        );

        await service.runTick("flagship");

        expect(mockFreeTierUsageService.getUsage).toHaveBeenCalledWith("flagship");
        expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "flagship" }, { active: false });
      });

      it("should dispatch across flagship's own models, evenly, the same way as mini", async () => {
        process.env.FREE_TIER_DISPATCH_MAX_BATCH = "2";
        process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 90,
        });
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("flagship"));
        mockStrategyService.countInFlightByModel.mockResolvedValueOnce(zeroCounts("flagship"));

        const allocation = new Map(FLAGSHIP_FREE_TIER.models.map((model) => [model, 5]));
        allocation.set("o1", 0);
        allocation.set("o3", 0);
        mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
        mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([
          { puzzleId: 7, date: "2024-03-01" },
        ]);

        await service.runTick("flagship");

        expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(2);
        const dispatchedModels = mockStrategyService.triggerStrategyRuns.mock.calls.map(
          (call) => call[3],
        );
        expect(new Set(dispatchedModels)).toEqual(new Set(["o1", "o3"]));
        // Never a mini-tier model, confirming this pulled from FLAGSHIP_FREE_TIER.
        expect(dispatchedModels).not.toContain("gpt-5-nano");
      });

      it("should run its own independent cycle without affecting mini's state", async () => {
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 90,
        });
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("flagship"));
        mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

        await service.runTick("flagship");

        expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "flagship" }, { active: false });
        expect(mockStateRepo.update).not.toHaveBeenCalledWith({ tier: "mini" }, expect.anything());
      });
    });
  });
});
