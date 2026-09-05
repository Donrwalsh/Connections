import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { OpenRouterFreeDispatchService } from "./openrouter-free-dispatch.service";
import { OpenRouterDispatchState } from "./entities/openrouter-dispatch-state.entity";
import { OPENROUTER_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { OpenRouterRateLimitHoldService } from "../strategy/openrouter-rate-limit-hold.service";

const OR_MODELS = ["z-ai/glm-5.2:free", "minimax/minimax-m3:free"];

describe("OpenRouterFreeDispatchService", () => {
  let service: OpenRouterFreeDispatchService;
  let stateRepo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let queue: { add: jest.Mock };
  let strategyService: {
    countTodayLlmCalls: jest.Mock;
    countInFlightByModel: jest.Mock;
    countTodayDispatchByModel: jest.Mock;
    findUnrunPuzzleDatesForModel: jest.Mock;
    triggerStrategyRuns: jest.Mock;
  };
  let supportedModelService: { findModelNamesByStrategy: jest.Mock };
  let holdService: { isHeld: jest.Mock; heldReason: jest.Mock; nextResetAt: jest.Mock };

  const zeroCounts = () => new Map(OR_MODELS.map((m) => [m, 0]));

  beforeEach(async () => {
    stateRepo = {
      findOne: jest.fn().mockResolvedValue({ id: "openrouter", active: false, startedAt: null }),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    strategyService = {
      countTodayLlmCalls: jest.fn().mockResolvedValue(0),
      countInFlightByModel: jest.fn().mockResolvedValue(zeroCounts()),
      countTodayDispatchByModel: jest.fn().mockResolvedValue(zeroCounts()),
      findUnrunPuzzleDatesForModel: jest
        .fn()
        .mockResolvedValue([{ puzzleId: 1, date: "2026-01-01" }]),
      triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
    };
    supportedModelService = {
      findModelNamesByStrategy: jest.fn().mockResolvedValue([...OR_MODELS]),
    };
    holdService = {
      isHeld: jest.fn().mockResolvedValue(false),
      heldReason: jest.fn().mockResolvedValue(null),
      nextResetAt: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenRouterFreeDispatchService,
        { provide: getRepositoryToken(OpenRouterDispatchState), useValue: stateRepo },
        { provide: OPENROUTER_FREE_DISPATCH_QUEUE, useValue: queue },
        { provide: StrategyService, useValue: strategyService },
        { provide: SupportedModelService, useValue: supportedModelService },
        { provide: OpenRouterRateLimitHoldService, useValue: holdService },
      ],
    }).compile();

    service = module.get(OpenRouterFreeDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENROUTER_FREE_DAILY_BUDGET;
    delete process.env.OPENROUTER_CALLS_PER_TRIAL_ESTIMATE;
    delete process.env.OPENROUTER_DISPATCH_MAX_BATCH;
  });

  describe("start", () => {
    it("starts a cycle and enqueues the first tick when under budget and not held", async () => {
      const { outcome } = await service.start();

      expect(outcome).toBe("started");
      expect(stateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "openrouter", active: true }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: 0, jobId: expect.stringContaining("openrouter-free-dispatch-") }),
      );
    });

    it("returns alreadyExhausted (no tick) when the account hold is live", async () => {
      holdService.isHeld.mockResolvedValue(true);

      const { outcome } = await service.start();

      expect(outcome).toBe("alreadyExhausted");
      expect(queue.add).not.toHaveBeenCalled();
      expect(stateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "openrouter", active: false }),
      );
    });

    it("returns alreadyExhausted when callsToday already meets the budget", async () => {
      strategyService.countTodayLlmCalls.mockResolvedValue(50);

      const { outcome } = await service.start();

      expect(outcome).toBe("alreadyExhausted");
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("throws when a cycle is already active", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true });

      await expect(service.start()).rejects.toThrow(BadRequestException);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("reports callsToday and the configured dailyBudget", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true, startedAt: null });
      strategyService.countTodayLlmCalls.mockResolvedValue(12);

      const status = await service.getStatus();

      expect(status).toEqual({ active: true, startedAt: null, callsToday: 12, dailyBudget: 50 });
    });
  });

  describe("runTick", () => {
    beforeEach(() =>
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true, startedAt: null }),
    );

    it("does nothing when the cycle is inactive", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: false });

      await service.runTick();

      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("stops the cycle when the account is daily-held", async () => {
      holdService.heldReason.mockResolvedValue("daily");

      await service.runTick();

      expect(stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("skips dispatching and reschedules after the cooldown when per-minute-cooldown is live", async () => {
      holdService.heldReason.mockResolvedValue("per-minute-cooldown");
      holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 45_000));

      await service.runTick();

      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: expect.any(Number) }),
      );
      expect(queue.add.mock.calls[0][2].delay).toBeGreaterThan(30_000);
    });

    it("stops the cycle when callsToday + estimated in-flight cost reaches the budget", async () => {
      strategyService.countTodayLlmCalls.mockResolvedValue(44);
      strategyService.countInFlightByModel.mockResolvedValue(
        new Map([["z-ai/glm-5.2:free", 1]]),
      );
      // 44 + 1*6 = 50 >= 50

      await service.runTick();

      expect(stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("dispatches a batch across the least-allocated models and reschedules", async () => {
      await service.runTick();

      expect(strategyService.triggerStrategyRuns).toHaveBeenCalled();
      expect(strategyService.triggerStrategyRuns.mock.calls[0]).toEqual([
        1,
        "llm-openrouter",
        "2026-01-01",
        expect.any(String),
      ]);
      expect(queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: 15_000 }),
      );
    });

    it("does not dispatch a whole trial when there is no budget headroom for one", async () => {
      // budget 50, callsToday 46, estimate 6 -> 4 calls of headroom -> 0 whole trials
      strategyService.countTodayLlmCalls.mockResolvedValue(46);

      await service.runTick();

      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: 15_000 }),
      );
    });

    it("stops when every model is out of unrun puzzles", async () => {
      strategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await service.runTick();

      expect(stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
    });

    it("honours an OPENROUTER_FREE_DAILY_BUDGET override", async () => {
      process.env.OPENROUTER_FREE_DAILY_BUDGET = "1000";
      strategyService.countTodayLlmCalls.mockResolvedValue(60);

      await service.runTick();

      expect(strategyService.triggerStrategyRuns).toHaveBeenCalled();
    });

    it("treats a triggerStrategyRuns failure as that model unavailable, not a hard failure", async () => {
      process.env.OPENROUTER_DISPATCH_MAX_BATCH = "1";
      strategyService.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

      await expect(service.runTick()).resolves.toBeUndefined();

      expect(stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
    });
  });
});
