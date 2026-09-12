import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { RUNS_QUEUE_BY_POOL, RPD_RESUME_QUEUE_BY_POOL } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { StrategyRun, StrategyRunStatus } from "../strategy/entities/strategy-run.entity";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";
import type { ProviderPoolId } from "./provider-pool.config";
import { RpdResumeService } from "./rpd-resume.service";

// 2026-01-15 12:00 PST — frozen so rearm() delay math is exact and Google's
// Pacific-date job-id stamp is a literal.
const FROZEN_NOW = new Date("2026-01-15T20:00:00Z");
const PACIFIC_STAMP = "2026-01-15";

type Mocks = {
  strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  holdService: {
    clearExpired: jest.Mock;
    heldModels: jest.Mock;
    nextResetAt: jest.Mock;
    isHeld: jest.Mock;
  };
  runsQueue: { add: jest.Mock };
  resumeQueue: { add: jest.Mock };
};

async function makeService(poolId: ProviderPoolId): Promise<{ service: RpdResumeService } & Mocks> {
  const strategyRunRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const holdService = {
    clearExpired: jest
      .fn()
      .mockResolvedValue({ clearedModels: [], clearedAccountWide: false }),
    heldModels: jest.fn().mockResolvedValue([]),
    nextResetAt: jest.fn().mockResolvedValue(null),
    isHeld: jest.fn().mockResolvedValue(false),
  };
  const runsQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const resumeQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RpdResumeService,
      { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
      { provide: RateLimitHoldService, useValue: holdService },
      { provide: RUNS_QUEUE_BY_POOL, useValue: new Map([[poolId, runsQueue]]) },
      { provide: RPD_RESUME_QUEUE_BY_POOL, useValue: new Map([[poolId, resumeQueue]]) },
    ],
  }).compile();

  return {
    service: module.get(RpdResumeService),
    strategyRunRepo,
    holdService,
    runsQueue,
    resumeQueue,
  };
}

const parkedRun = (
  strategyName: string,
  over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } },
) =>
  ({
    id: 1,
    puzzleId: 10,
    strategyName,
    trialNumber: 0,
    modelName: "model-a",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  }) as unknown as StrategyRun;

// ---------------------------------------------------------------------------
// Per-model pools: google (fixed-cron) + the three self-rearm pools share one
// sweep implementation; only the resume job-id stamp differs.
// ---------------------------------------------------------------------------
describe.each([
  ["groq", "llm-groq", "self-rearm"],
  ["mistral", "llm-mistral", "self-rearm"],
  ["sambanova", "llm-sambanova", "self-rearm"],
  ["google", "llm-google", "fixed-cron"],
] as const)("RpdResumeService — %s (per-model)", (poolId, strategyName, scheduleKind) => {
  let m: { service: RpdResumeService } & Mocks;
  const run = (over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } }) =>
    parkedRun(strategyName, over);
  const invoke = () =>
    scheduleKind === "self-rearm"
      ? m.service.runResume(poolId, "sweep-1")
      : m.service.runResume(poolId);

  beforeEach(async () => {
    m = await makeService(poolId);
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }).setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("revives parked runs whose model is no longer held and re-enqueues them", async () => {
    m.holdService.clearExpired.mockResolvedValue({
      clearedModels: ["model-a"],
      clearedAccountWide: false,
    });
    m.holdService.heldModels.mockResolvedValue(["model-b"]);
    m.holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 5 * 60_000));
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, modelName: "model-a", puzzle: { date: "2026-01-01" } }),
      run({ id: 2, puzzleId: 11, trialNumber: 1, modelName: "model-b", puzzle: { date: "2026-01-02" } }),
    ]);

    const result = await invoke();

    expect(m.strategyRunRepo.save).toHaveBeenCalledTimes(1);
    expect(m.strategyRunRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: StrategyRunStatus.RUNNING }),
    );
    expect(m.runsQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      {
        puzzleId: 10,
        strategyName,
        date: "2026-01-01",
        trialNumber: 0,
        model: "model-a",
      },
      {
        jobId: expect.stringMatching(
          new RegExp(`^${runStrategyJobId(10, strategyName, 0)}-resume-`),
        ),
      },
    );
    expect(result).toMatchObject({ cleared: ["model-a"], redispatched: 1 });
  });

  it("re-enqueues under an id distinct from the run's original deterministic job id", async () => {
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await invoke();

    const jobId = (m.runsQueue.add.mock.calls[0][2] as { jobId: string }).jobId;
    expect(jobId).not.toBe(runStrategyJobId(10, strategyName, 0));
    expect(jobId.startsWith(`${runStrategyJobId(10, strategyName, 0)}-`)).toBe(true);
  });

  it("uses the same id for every run within one sweep, so a retried sweep collapses to one job", async () => {
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await invoke();
    await invoke();

    const first = (m.runsQueue.add.mock.calls[0][2] as { jobId: string }).jobId;
    const second = (m.runsQueue.add.mock.calls[1][2] as { jobId: string }).jobId;
    expect(second).toBe(first);
  });

  it("leaves a run parked (not flipped to RUNNING) when the enqueue fails", async () => {
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);
    m.runsQueue.add.mockRejectedValue(new Error("redis down"));

    await expect(invoke()).rejects.toThrow("redis down");

    expect(m.strategyRunRepo.save).not.toHaveBeenCalled();
  });

  it("skips a parked run with no modelName rather than dispatching an ungated call", async () => {
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, modelName: null, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await invoke();

    expect(m.runsQueue.add).not.toHaveBeenCalled();
    expect(m.strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("re-arms a delayed sweep when parked runs remain, capped at 15 minutes", async () => {
    m.holdService.heldModels.mockResolvedValue(["model-a"]);
    m.holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 5 * 60_000));
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await invoke();

    expect(result.rearmedInMs).toBe(5 * 60_000);
    expect(m.resumeQueue.add).toHaveBeenCalledWith(
      `resume-${poolId}-rpd`,
      {},
      expect.objectContaining({ delay: 5 * 60_000, jobId: expect.stringContaining("rearm") }),
    );
  });

  it("caps the re-arm delay when the soonest reset is far away", async () => {
    m.holdService.heldModels.mockResolvedValue(["model-a"]);
    m.holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 6 * 60 * 60_000));
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await invoke();

    expect(result.rearmedInMs).toBe(15 * 60_000);
  });

  it("does not re-arm when every parked run was revived", async () => {
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await invoke();

    expect(m.resumeQueue.add).not.toHaveBeenCalled();
    expect(result.rearmedInMs).toBeUndefined();
  });

  it("does nothing when there are no parked runs", async () => {
    m.strategyRunRepo.find.mockResolvedValue([]);

    const result = await invoke();

    expect(m.strategyRunRepo.save).not.toHaveBeenCalled();
    expect(m.runsQueue.add).not.toHaveBeenCalled();
    expect(m.resumeQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: [], redispatched: 0 });
  });
});

describe("RpdResumeService — self-rearm job-id stamping (groq)", () => {
  let m: { service: RpdResumeService } & Mocks;
  beforeEach(async () => {
    m = await makeService("groq");
    m.strategyRunRepo.find.mockResolvedValue([
      parkedRun("llm-groq", { id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);
  });
  afterEach(() => jest.clearAllMocks());

  it("uses a distinct id for a different triggering job, so separate sweeps don't collide", async () => {
    await m.service.runResume("groq", "sweep-1");
    await m.service.runResume("groq", "sweep-2");

    const first = (m.runsQueue.add.mock.calls[0][2] as { jobId: string }).jobId;
    const second = (m.runsQueue.add.mock.calls[1][2] as { jobId: string }).jobId;
    expect(second).not.toBe(first);
    expect(first.endsWith("-resume-sweep-1")).toBe(true);
  });
});

describe("RpdResumeService — fixed-cron job-id stamping (google)", () => {
  it("stamps the resume job id with the Pacific calendar date", async () => {
    const m = await makeService("google");
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }).setSystemTime(FROZEN_NOW);
    m.strategyRunRepo.find.mockResolvedValue([
      parkedRun("llm-google", { id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await m.service.runResume("google");

    expect((m.runsQueue.add.mock.calls[0][2] as { jobId: string }).jobId).toBe(
      `run-10-llm-google-0-resume-${PACIFIC_STAMP}`,
    );
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Account-wide pool: openrouter clears the single account hold and, if it
// lifted, re-dispatches every parked run (no per-model gate, no re-arm).
// ---------------------------------------------------------------------------
describe("RpdResumeService — openrouter (account-wide)", () => {
  let m: { service: RpdResumeService } & Mocks;
  const run = (over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } }) =>
    parkedRun("llm-openrouter", { modelName: "z-ai/glm-5.2:free", ...over });

  beforeEach(async () => {
    m = await makeService("openrouter");
    m.holdService.clearExpired.mockResolvedValue({
      clearedModels: [],
      clearedAccountWide: true,
    });
  });
  afterEach(() => jest.clearAllMocks());

  it("clears the expired hold and re-dispatches every parked run", async () => {
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
      run({ id: 2, puzzleId: 11, trialNumber: 1, puzzle: { date: "2026-01-02" } }),
    ]);

    const result = await m.service.runResume("openrouter");

    expect(m.holdService.clearExpired).toHaveBeenCalled();
    expect(m.strategyRunRepo.save).toHaveBeenCalledTimes(2);
    expect(m.runsQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      expect.objectContaining({ strategyName: "llm-openrouter", puzzleId: 10, date: "2026-01-01" }),
      {
        jobId: expect.stringMatching(
          new RegExp(`^${runStrategyJobId(10, "llm-openrouter", 0)}-resume-`),
        ),
      },
    );
    expect(result).toEqual({ cleared: true, redispatched: 2 });
  });

  it("re-dispatches nothing while the account hold is still live", async () => {
    m.holdService.clearExpired.mockResolvedValue({
      clearedModels: [],
      clearedAccountWide: false,
    });
    m.holdService.isHeld.mockResolvedValue(true);
    m.strategyRunRepo.find.mockResolvedValue([run({ puzzle: { date: "2026-01-01" } })]);

    const result = await m.service.runResume("openrouter");

    expect(m.runsQueue.add).not.toHaveBeenCalled();
    expect(m.strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: false, redispatched: 0 });
  });

  it("uses one stamp for every run in a sweep and an id distinct from the run's original job id", async () => {
    m.strategyRunRepo.find.mockResolvedValue([
      run({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
      run({ id: 2, puzzleId: 11, trialNumber: 0, puzzle: { date: "2026-01-02" } }),
    ]);

    await m.service.runResume("openrouter");

    const firstId = m.runsQueue.add.mock.calls[0][2].jobId as string;
    const secondId = m.runsQueue.add.mock.calls[1][2].jobId as string;
    expect(firstId.split("-resume-")[1]).toBe(secondId.split("-resume-")[1]);
    expect(firstId).not.toBe(runStrategyJobId(10, "llm-openrouter", 0));
  });

  it("leaves a run parked when its enqueue fails (without rethrowing)", async () => {
    m.runsQueue.add.mockRejectedValueOnce(new Error("redis down"));
    m.strategyRunRepo.find.mockResolvedValue([run({ puzzle: { date: "2026-01-01" } })]);

    const result = await m.service.runResume("openrouter");

    expect(m.strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("does nothing when there are no parked runs", async () => {
    const result = await m.service.runResume("openrouter");

    expect(m.runsQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: true, redispatched: 0 });
  });
});
