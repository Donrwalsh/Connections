import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MistralRpdResumeService } from "./mistral-rpd-resume.service";
import { RateLimitHoldService } from "./rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { MISTRAL_RPD_RESUME_QUEUE, LLM_MISTRAL_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";

// Frozen so every Date.now() call — in the test body and inside the
// service's own rearm() math — reads the exact same instant.
const FROZEN_NOW = new Date("2026-01-15T20:00:00Z");

describe("MistralRpdResumeService", () => {
  let service: MistralRpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; heldModels: jest.Mock; nextResetAt: jest.Mock };
  let queue: { add: jest.Mock };
  let resumeQueue: { add: jest.Mock };

  const parkedRun = (over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } }) => ({
    id: 1,
    puzzleId: 10,
    strategyName: "llm-mistral",
    trialNumber: 0,
    modelName: "mistral-small-latest",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  });

  beforeEach(async () => {
    strategyRunRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    };
    holdService = {
      clearExpired: jest.fn().mockResolvedValue({ clearedModels: [], clearedAccountWide: false }),
      heldModels: jest.fn().mockResolvedValue([]),
      nextResetAt: jest.fn().mockResolvedValue(null),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    resumeQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MistralRpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: RateLimitHoldService, useValue: holdService },
        { provide: LLM_MISTRAL_QUEUE, useValue: queue },
        { provide: MISTRAL_RPD_RESUME_QUEUE, useValue: resumeQueue },
      ],
    }).compile();

    service = module.get(MistralRpdResumeService);

    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }).setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("revives parked runs whose model is no longer held and re-enqueues them", async () => {
    holdService.clearExpired.mockResolvedValue({ clearedModels: ["mistral-small-latest"], clearedAccountWide: false });
    holdService.heldModels.mockResolvedValue(["ministral-8b-latest"]);
    holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 5 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: "mistral-small-latest", puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 1, modelName: "ministral-8b-latest", puzzle: { date: "2026-01-02" } }),
    ]);

    const result = await service.runResume("sweep-1");

    expect(strategyRunRepo.save).toHaveBeenCalledTimes(1);
    expect(strategyRunRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: StrategyRunStatus.RUNNING }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "run-strategy",
      {
        puzzleId: 10,
        strategyName: "llm-mistral",
        date: "2026-01-01",
        trialNumber: 0,
        model: "mistral-small-latest",
      },
      { jobId: expect.stringMatching(new RegExp(`^${runStrategyJobId(10, "llm-mistral", 0)}-resume-`)) },
    );
    expect(result).toMatchObject({ cleared: ["mistral-small-latest"], redispatched: 1 });
  });

  it("uses a distinct id for a different triggering job, so separate sweeps don't collide", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await service.runResume("sweep-1");
    await service.runResume("sweep-2");

    const first = (queue.add.mock.calls[0][2] as { jobId: string }).jobId;
    const second = (queue.add.mock.calls[1][2] as { jobId: string }).jobId;
    expect(second).not.toBe(first);
  });

  it("leaves a run parked (not flipped to RUNNING) when the enqueue fails", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);
    queue.add.mockRejectedValue(new Error("redis down"));

    await expect(service.runResume("sweep-1")).rejects.toThrow("redis down");

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
  });

  it("skips a parked run with no modelName", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: null, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume("sweep-1");

    expect(queue.add).not.toHaveBeenCalled();
    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("re-arms a delayed sweep at the soonest live resetAt when parked runs remain, capped at 15 minutes", async () => {
    holdService.heldModels.mockResolvedValue(["mistral-small-latest"]);
    holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 5 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume("sweep-1");

    expect(result.rearmedInMs).toBe(5 * 60_000);
    expect(resumeQueue.add).toHaveBeenCalledWith(
      "resume-mistral-rpd",
      {},
      expect.objectContaining({ delay: 5 * 60_000, jobId: expect.stringContaining("rearm") }),
    );
  });

  it("caps the re-arm delay when the soonest reset is far away", async () => {
    holdService.heldModels.mockResolvedValue(["mistral-small-latest"]);
    holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 6 * 60 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume("sweep-1");

    expect(result.rearmedInMs).toBe(15 * 60_000);
  });

  it("does not re-arm when every parked run was revived", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume("sweep-1");

    expect(resumeQueue.add).not.toHaveBeenCalled();
    expect(result.rearmedInMs).toBeUndefined();
  });

  it("does nothing when there are no parked runs", async () => {
    holdService.clearExpired.mockResolvedValue({ clearedModels: [], clearedAccountWide: false });
    strategyRunRepo.find.mockResolvedValue([]);

    const result = await service.runResume("sweep-1");

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(resumeQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: [], redispatched: 0 });
  });
});
