import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";

import { FREE_DISPATCH_QUEUE_BY_POOL } from "../queue/queue.module";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { DispatchState } from "./entities/dispatch-state.entity";
import { FreeDispatchService } from "./free-dispatch.service";
import type { ProviderPoolId } from "./provider-pool.config";

const MODELS = ["model-a", "model-b"];
const zeroCounts = () => new Map(MODELS.map((m) => [m, 0]));

type Mocks = {
  stateRepo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  queue: { add: jest.Mock };
  strategyService: {
    countTodayLlmCalls: jest.Mock;
    countInFlightByModel: jest.Mock;
    countTodayDispatchByModel: jest.Mock;
    findUnrunPuzzleDatesForModel: jest.Mock;
    triggerStrategyRuns: jest.Mock;
  };
  supportedModelService: { findModelNamesByStrategy: jest.Mock };
  holdService: {
    heldModels: jest.Mock;
    isHeld: jest.Mock;
    heldReason: jest.Mock;
    nextResetAt: jest.Mock;
  };
};

async function makeService(
  poolId: ProviderPoolId,
): Promise<{ service: FreeDispatchService } & Mocks> {
  const stateRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const strategyService = {
    countTodayLlmCalls: jest.fn().mockResolvedValue(0),
    countInFlightByModel: jest.fn().mockResolvedValue(zeroCounts()),
    countTodayDispatchByModel: jest.fn().mockResolvedValue(zeroCounts()),
    findUnrunPuzzleDatesForModel: jest.fn().mockResolvedValue([{ puzzleId: 1, date: "2026-01-01" }]),
    triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
  };
  const supportedModelService = {
    findModelNamesByStrategy: jest.fn().mockResolvedValue([...MODELS]),
  };
  const holdService = {
    heldModels: jest.fn().mockResolvedValue([]),
    isHeld: jest.fn().mockResolvedValue(false),
    heldReason: jest.fn().mockResolvedValue(null),
    nextResetAt: jest.fn().mockResolvedValue(null),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      FreeDispatchService,
      { provide: getRepositoryToken(DispatchState), useValue: stateRepo },
      { provide: FREE_DISPATCH_QUEUE_BY_POOL, useValue: new Map([[poolId, queue]]) },
      { provide: StrategyService, useValue: strategyService },
      { provide: SupportedModelService, useValue: supportedModelService },
      { provide: RateLimitHoldService, useValue: holdService },
    ],
  }).compile();

  return {
    service: module.get(FreeDispatchService),
    stateRepo,
    queue,
    strategyService,
    supportedModelService,
    holdService,
  };
}

// ---------------------------------------------------------------------------
// until-held pools: google / groq / mistral (shared pacing) + sambanova
// (dedicated pacing). Same "dispatch until every model is held or out of
// puzzles" cycle.
// ---------------------------------------------------------------------------
describe.each([
  ["google", "llm-google"],
  ["groq", "llm-groq"],
  ["mistral", "llm-mistral"],
  ["sambanova", "llm-sambanova"],
] as const)("FreeDispatchService — %s (until-held)", (poolId, strategyName) => {
  let m: { service: FreeDispatchService } & Mocks;

  const setBatch = (n: string) => {
    process.env.FREE_TIER_DISPATCH_MAX_BATCH = n;
    process.env.SAMBANOVA_DISPATCH_MAX_BATCH = n;
  };
  const setInFlight = (n: string) => {
    process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = n;
    process.env.SAMBANOVA_DISPATCH_MAX_IN_FLIGHT = n;
  };

  beforeEach(async () => {
    m = await makeService(poolId);
  });
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.FREE_TIER_DISPATCH_MAX_BATCH;
    delete process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT;
    delete process.env.SAMBANOVA_DISPATCH_MAX_BATCH;
    delete process.env.SAMBANOVA_DISPATCH_MAX_IN_FLIGHT;
  });

  describe("start", () => {
    it("rejects starting a cycle that's already active", async () => {
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });

      await expect(m.service.start(poolId)).rejects.toThrow(BadRequestException);
      expect(m.queue.add).not.toHaveBeenCalled();
    });

    it("reports alreadyExhausted (no tick) when every model is held", async () => {
      m.stateRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: poolId, active: false, startedAt: null });
      m.holdService.heldModels.mockResolvedValueOnce([...MODELS]);

      const result = await m.service.start(poolId);

      expect(result.outcome).toBe("alreadyExhausted");
      expect(m.queue.add).not.toHaveBeenCalled();
      expect(m.stateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: poolId, active: false }),
      );
    });

    it("starts a cycle and queues the first tick when at least one model is free", async () => {
      m.stateRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: poolId, active: true, startedAt: new Date() });
      m.holdService.heldModels.mockResolvedValueOnce(["model-b"]);

      const result = await m.service.start(poolId);

      expect(result.outcome).toBe("started");
      expect(m.stateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: poolId, active: true }),
      );
      expect(m.queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: 0, jobId: expect.stringContaining(`${poolId}-free-dispatch-`) }),
      );
    });
  });

  describe("stop", () => {
    it("deactivates the cycle and returns its status", async () => {
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: false, startedAt: null });

      const result = await m.service.stop(poolId);

      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: poolId }, { active: false });
      expect(result.active).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("reports active/startedAt only (no budget fields)", async () => {
      m.stateRepo.findOne.mockResolvedValueOnce(null);

      const result = await m.service.getStatus(poolId);

      expect(result).toEqual({ active: false, startedAt: null });
    });
  });

  describe("runTick", () => {
    it("does nothing when the cycle is inactive", async () => {
      m.stateRepo.findOne.mockResolvedValueOnce(null);

      await m.service.runTick(poolId);

      expect(m.supportedModelService.findModelNamesByStrategy).not.toHaveBeenCalled();
    });

    it("stops when no models are configured", async () => {
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });
      m.supportedModelService.findModelNamesByStrategy.mockResolvedValueOnce([]);

      await m.service.runTick(poolId);

      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: poolId }, { active: false });
      expect(m.queue.add).not.toHaveBeenCalled();
    });

    it("stops once every model is RPD-held", async () => {
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });
      m.holdService.heldModels.mockResolvedValueOnce([...MODELS]);

      await m.service.runTick(poolId);

      expect(m.strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: poolId }, { active: false });
    });

    it("holds off dispatching, but keeps ticking, once the in-flight backlog hits its cap", async () => {
      setInFlight("2");
      const inFlight = zeroCounts();
      inFlight.set("model-a", 3);
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });
      m.strategyService.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await m.service.runTick(poolId);

      expect(m.strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(m.stateRepo.update).not.toHaveBeenCalled();
      expect(m.queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("dispatches only to eligible (non-held) models, least-allocated first", async () => {
      setBatch("1");
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });
      m.holdService.heldModels.mockResolvedValueOnce(["model-a"]);
      m.strategyService.countTodayDispatchByModel.mockResolvedValueOnce(new Map([["model-b", 0]]));
      m.strategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([{ puzzleId: 9, date: "2026-05-01" }]);

      await m.service.runTick(poolId);

      expect(m.strategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(m.strategyService.triggerStrategyRuns).toHaveBeenCalledWith(
        9,
        strategyName,
        "2026-05-01",
        "model-b",
      );
    });

    it("stops when every eligible model has run out of unrun puzzles", async () => {
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });
      m.strategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await m.service.runTick(poolId);

      expect(m.strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: poolId }, { active: false });
    });

    it("treats a triggerStrategyRuns failure as that model unavailable this tick, not a hard failure", async () => {
      setBatch("1");
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });
      m.strategyService.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

      await expect(m.service.runTick(poolId)).resolves.toBeUndefined();

      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: poolId }, { active: false });
    });

    it("schedules a further tick after a successful partial dispatch", async () => {
      setBatch("1");
      m.stateRepo.findOne.mockResolvedValueOnce({ id: poolId, active: true });

      await m.service.runTick(poolId);

      expect(m.strategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(m.stateRepo.update).not.toHaveBeenCalled();
      expect(m.queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// account-budget pool: openrouter. Stop condition is a self-counted daily
// call budget; a live per-minute-cooldown hold pauses a tick.
// ---------------------------------------------------------------------------
describe("FreeDispatchService — openrouter (account-budget)", () => {
  let m: { service: FreeDispatchService } & Mocks;

  beforeEach(async () => {
    m = await makeService("openrouter");
    m.stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: false, startedAt: null });
  });
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENROUTER_FREE_DAILY_BUDGET;
    delete process.env.OPENROUTER_CALLS_PER_TRIAL_ESTIMATE;
    delete process.env.OPENROUTER_DISPATCH_MAX_BATCH;
  });

  describe("start", () => {
    it("starts a cycle and enqueues the first tick when under budget and not held", async () => {
      const { outcome } = await m.service.start("openrouter");

      expect(outcome).toBe("started");
      expect(m.stateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "openrouter", active: true }),
      );
      expect(m.queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: 0, jobId: expect.stringContaining("openrouter-free-dispatch-") }),
      );
    });

    it("returns alreadyExhausted (no tick) when the account hold is live", async () => {
      m.holdService.isHeld.mockResolvedValue(true);

      const { outcome } = await m.service.start("openrouter");

      expect(outcome).toBe("alreadyExhausted");
      expect(m.queue.add).not.toHaveBeenCalled();
      expect(m.stateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "openrouter", active: false }),
      );
    });

    it("returns alreadyExhausted when callsToday already meets the budget", async () => {
      m.strategyService.countTodayLlmCalls.mockResolvedValue(50);

      const { outcome } = await m.service.start("openrouter");

      expect(outcome).toBe("alreadyExhausted");
      expect(m.queue.add).not.toHaveBeenCalled();
    });

    it("throws when a cycle is already active", async () => {
      m.stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true });

      await expect(m.service.start("openrouter")).rejects.toThrow(BadRequestException);
      expect(m.queue.add).not.toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("reports callsToday and the configured dailyBudget", async () => {
      m.stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true, startedAt: null });
      m.strategyService.countTodayLlmCalls.mockResolvedValue(12);

      const status = await m.service.getStatus("openrouter");

      expect(status).toEqual({ active: true, startedAt: null, callsToday: 12, dailyBudget: 50 });
    });
  });

  describe("runTick", () => {
    beforeEach(() =>
      m.stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true, startedAt: null }),
    );

    it("does nothing when the cycle is inactive", async () => {
      m.stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: false });

      await m.service.runTick("openrouter");

      expect(m.strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("stops the cycle when the account is daily-held", async () => {
      m.holdService.heldReason.mockResolvedValue("daily");

      await m.service.runTick("openrouter");

      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
      expect(m.queue.add).not.toHaveBeenCalled();
    });

    it("skips dispatching and reschedules after the cooldown when per-minute-cooldown is live", async () => {
      m.holdService.heldReason.mockResolvedValue("per-minute-cooldown");
      m.holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 45_000));

      await m.service.runTick("openrouter");

      expect(m.strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(m.queue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: expect.any(Number) }),
      );
      expect(m.queue.add.mock.calls[0][2].delay).toBeGreaterThan(30_000);
    });

    it("stops the cycle when callsToday + estimated in-flight cost reaches the budget", async () => {
      m.strategyService.countTodayLlmCalls.mockResolvedValue(44);
      m.strategyService.countInFlightByModel.mockResolvedValue(new Map([["model-a", 1]]));

      await m.service.runTick("openrouter");

      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
      expect(m.strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("dispatches a batch across the least-allocated models and reschedules", async () => {
      await m.service.runTick("openrouter");

      expect(m.strategyService.triggerStrategyRuns).toHaveBeenCalled();
      expect(m.strategyService.triggerStrategyRuns.mock.calls[0]).toEqual([
        1,
        "llm-openrouter",
        "2026-01-01",
        expect.any(String),
      ]);
      expect(m.queue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: 15_000 }));
    });

    it("does not dispatch a whole trial when there is no budget headroom for one", async () => {
      m.strategyService.countTodayLlmCalls.mockResolvedValue(46);

      await m.service.runTick("openrouter");

      expect(m.strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(m.queue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: 15_000 }));
    });

    it("stops when every model is out of unrun puzzles", async () => {
      m.strategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await m.service.runTick("openrouter");

      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
    });

    it("honours an OPENROUTER_FREE_DAILY_BUDGET override", async () => {
      process.env.OPENROUTER_FREE_DAILY_BUDGET = "1000";
      m.strategyService.countTodayLlmCalls.mockResolvedValue(60);

      await m.service.runTick("openrouter");

      expect(m.strategyService.triggerStrategyRuns).toHaveBeenCalled();
    });

    it("treats a triggerStrategyRuns failure as that model unavailable, not a hard failure", async () => {
      process.env.OPENROUTER_DISPATCH_MAX_BATCH = "1";
      m.strategyService.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

      await expect(m.service.runTick("openrouter")).resolves.toBeUndefined();

      expect(m.stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
    });
  });
});
