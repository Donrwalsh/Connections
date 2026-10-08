import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierDispatchService } from "./free-tier-dispatch.service";
import { FreeTierDispatchState } from "./entities/free-tier-dispatch-state.entity";
import { FREE_TIER_DISPATCH_QUEUE } from "../queue/queue.module";
import { StrategyDispatch } from "../strategy/strategy-dispatch.service";
import { FreeTierId, FreeTierUsageService } from "../strategy/free-tier-usage.service";
import { FreeTierBudgetService } from "../strategy/free-tier-budget.service";

const FLAGSHIP_MODELS = ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"];
const MINI_MODELS = [
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o3-mini",
  "o4-mini",
  "gpt-5-nano",
];
const FLAGSHIP_LIMIT = 250_000;
const MINI_LIMIT = 2_500_000;
const FLAGSHIP_LABEL = "Flagship models";
const MINI_LABEL = "Mini & nano models";

describe("FreeTierDispatchService", () => {
  let service: FreeTierDispatchService;
  let mockStateRepo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockStrategyDispatch: {
    countInFlightByModel: jest.Mock;
    countTodayDispatchByModel: jest.Mock;
    findUnrunPuzzleDatesForModel: jest.Mock;
    triggerStrategyRuns: jest.Mock;
    resumeBudgetParkedRuns: jest.Mock;
  };
  let mockFreeTierUsageService: { getUsage: jest.Mock };
  let mockFreeTierBudget: { committedTokens: jest.Mock; modelCaps: jest.Mock };

  const zeroCounts = (tier: FreeTierId = "mini") => {
    const models = tier === "mini" ? MINI_MODELS : FLAGSHIP_MODELS;
    return new Map(models.map((model) => [model, 0]));
  };

  // Default usage stub for a tier: zero spend, full budget remaining. Tests
  // override with mockResolvedValueOnce for the specific numbers they need.
  const usageStub = (tier: FreeTierId, overrides: Record<string, unknown> = {}) => {
    const isMini = tier === "mini";
    return {
      tier,
      label: isMini ? MINI_LABEL : FLAGSHIP_LABEL,
      usedTokens: 0,
      dailyLimitTokens: isMini ? MINI_LIMIT : FLAGSHIP_LIMIT,
      remainingTokens: isMini ? MINI_LIMIT : FLAGSHIP_LIMIT,
      models: [...(isMini ? MINI_MODELS : FLAGSHIP_MODELS)],
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
    mockStrategyDispatch = {
      countInFlightByModel: jest.fn().mockResolvedValue(zeroCounts()),
      countTodayDispatchByModel: jest.fn().mockResolvedValue(zeroCounts()),
      findUnrunPuzzleDatesForModel: jest.fn().mockResolvedValue([{ puzzleId: 1, date: "2024-01-01" }]),
      triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
      resumeBudgetParkedRuns: jest.fn().mockResolvedValue([]),
    };
    mockFreeTierUsageService = {
      getUsage: jest.fn().mockImplementation(async (tier: FreeTierId) => usageStub(tier)),
    };
    mockFreeTierBudget = {
      committedTokens: jest.fn().mockResolvedValue(0),
      // Default: every model capped at 1,000 → a 3,000-token soft worst case,
      // so budget is never the limiting factor unless a test says so.
      modelCaps: jest
        .fn()
        .mockImplementation(async (models: string[]) => new Map(models.map((model) => [model, 1000]))),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreeTierDispatchService,
        { provide: getRepositoryToken(FreeTierDispatchState), useValue: mockStateRepo },
        { provide: FREE_TIER_DISPATCH_QUEUE, useValue: mockQueue },
        { provide: StrategyDispatch, useValue: mockStrategyDispatch },
        { provide: FreeTierUsageService, useValue: mockFreeTierUsageService },
        { provide: FreeTierBudgetService, useValue: mockFreeTierBudget },
      ],
    }).compile();

    service = module.get<FreeTierDispatchService>(FreeTierDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.FREE_TIER_DISPATCH_MAX_BATCH;
    delete process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT;
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
      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
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
      mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStrategyDispatch.countTodayDispatchByModel).not.toHaveBeenCalled();
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
      const inFlight = zeroCounts();
      inFlight.set("gpt-4.1-nano", 2); // cap is 3, so only 1 more trial has headroom
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(1);
    });

    it("should hold off on new dispatches, but keep ticking, when the token budget is nearly spoken for", async () => {
      // Raise the in-flight cap so this test exercises the budget sizing
      // specifically, not the (lower-priority) in-flight cap above.
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "1000";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      // 900 in flight × (1,000 cap + 2,000 allowance) = 2.7M soft-reserved > 2.25M room.
      const heavyInFlight = new Map(MINI_MODELS.map((model) => [model, 100]));
      mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(heavyInFlight);

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("stops with 'budget reached' when no model's worst case fits and nothing is in flight", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      // threshold 2,250,000; room 2,500 < 1,000 cap + 2,000 allowance.
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_247_500);

      await service.runTick("mini");

      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("keeps ticking (doesn't stop) when nothing fits but trials are still in flight", async () => {
      const inFlight = zeroCounts();
      inFlight.set("gpt-4.1-nano", 1);
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(inFlight);
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_247_500);

      await service.runTick("mini");

      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith("tick", { tier: "mini" }, expect.anything());
    });

    it("only dispatches models whose worst case fits the remaining room", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_240_000); // room 10,000
      mockFreeTierBudget.modelCaps.mockResolvedValueOnce(
        new Map(MINI_MODELS.map((m) => [m, m === "gpt-4.1-nano" ? 4000 : 36000])),
      );

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledWith(
        1,
        "llm-openai",
        "2024-01-01",
        "gpt-4.1-nano",
        "mini",
      );
    });

    it("never dispatches a model with no output cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "3";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockFreeTierBudget.modelCaps.mockResolvedValueOnce(
        new Map(MINI_MODELS.map((m) => [m, m === "o3-mini" ? 29000 : null])),
      );

      await service.runTick("mini");

      const models = mockStrategyDispatch.triggerStrategyRuns.mock.calls.map((call) => call[3]);
      expect(models.length).toBeGreaterThan(0);
      expect(new Set(models)).toEqual(new Set(["o3-mini"]));
    });

    it("sets aside a worst-case call for each in-flight trial before sizing new ones", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "5";
      const inFlight = zeroCounts();
      inFlight.set("o4-mini", 1); // 4,000 cap + 2,000 allowance = 6,000 set aside
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(inFlight);
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_240_000); // room 10,000 → 4,000 left
      mockFreeTierBudget.modelCaps.mockResolvedValueOnce(
        new Map(MINI_MODELS.map((m) => [m, m === "gpt-5.4-nano" ? 1000 : 4000])),
      );

      await service.runTick("mini");

      // Only one 3,000-token model fits in the 4,000 left; the 6,000 ones never do.
      const models = mockStrategyDispatch.triggerStrategyRuns.mock.calls.map((call) => call[3]);
      expect(models).toEqual(["gpt-5.4-nano"]);
    });

    it("resumes budget-paused runs before dispatching new trials, sharing the batch", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "2";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.resumeBudgetParkedRuns.mockResolvedValueOnce(["o3-mini"]);

      await service.runTick("mini");

      expect(mockStrategyDispatch.resumeBudgetParkedRuns).toHaveBeenCalledWith(
        "llm-openai",
        "mini",
        expect.arrayContaining(MINI_MODELS),
        2,
      );
      expect(mockStrategyDispatch.resumeBudgetParkedRuns.mock.invocationCallOrder[0]).toBeLessThan(
        mockStrategyDispatch.countTodayDispatchByModel.mock.invocationCallOrder[0],
      );
      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(1);
    });

    it("should dispatch to the least-allocated models first, up to the batch cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "2";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      // Every model starts well-represented except two, which are the only
      // ones that should receive this tick's dispatches.
      const allocation = new Map(MINI_MODELS.map((model) => [model, 5]));
      allocation.set("o4-mini", 0);
      allocation.set("o3-mini", 0);
      mockStrategyDispatch.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
      mockStrategyDispatch.findUnrunPuzzleDatesForModel.mockResolvedValue([
        { puzzleId: 42, date: "2024-06-01" },
      ]);

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(2);
      const dispatchedModels = mockStrategyDispatch.triggerStrategyRuns.mock.calls.map((call) => call[3]);
      expect(new Set(dispatchedModels)).toEqual(new Set(["o4-mini", "o3-mini"]));
    });

    it("should schedule a further tick after a successful partial dispatch", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should skip a model with no unrun puzzles left and try the next one", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      const allocation = zeroCounts();
      mockStrategyDispatch.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
      // Every model ties at 0, so iteration order decides who's tried
      // first — exhaust all of them except the last so the loop is forced
      // to fall through to a model that actually has a puzzle.
      mockStrategyDispatch.findUnrunPuzzleDatesForModel.mockResolvedValue([]);
      mockStrategyDispatch.findUnrunPuzzleDatesForModel.mockImplementation(async (_s, model: string) =>
        model === "gpt-5-nano" ? [{ puzzleId: 1, date: "2024-01-01" }] : [],
      );

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledWith(
        1,
        "llm-openai",
        "2024-01-01",
        "gpt-5-nano",
        "mini",
      );
    });

    it("should stop the cycle when every model has run out of unrun puzzles", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should treat a triggerStrategyRuns failure as that model being unavailable this tick, not a hard failure", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

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
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 90,
        });
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("flagship"));
        mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(zeroCounts("flagship"));

        const allocation = new Map(FLAGSHIP_MODELS.map((model) => [model, 5]));
        allocation.set("o1", 0);
        allocation.set("o3", 0);
        mockStrategyDispatch.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
        mockStrategyDispatch.findUnrunPuzzleDatesForModel.mockResolvedValue([
          { puzzleId: 7, date: "2024-03-01" },
        ]);

        await service.runTick("flagship");

        expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(2);
        const dispatchedModels = mockStrategyDispatch.triggerStrategyRuns.mock.calls.map(
          (call) => call[3],
        );
        expect(new Set(dispatchedModels)).toEqual(new Set(["o1", "o3"]));
        // Never a mini-tier model, confirming this pulled from the flagship usage stub.
        expect(dispatchedModels).not.toContain("gpt-5-nano");
      });

      it("should run its own independent cycle without affecting mini's state", async () => {
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 90,
        });
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("flagship"));
        mockStrategyDispatch.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

        await service.runTick("flagship");

        expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "flagship" }, { active: false });
        expect(mockStateRepo.update).not.toHaveBeenCalledWith({ tier: "mini" }, expect.anything());
      });
    });
  });
});
