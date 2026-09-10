import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { OpenRouterRpdResumeService } from "./openrouter-rpd-resume.service";
import { RateLimitHoldService } from "./rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { LLM_OPENROUTER_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";

describe("OpenRouterRpdResumeService", () => {
  let service: OpenRouterRpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; isHeld: jest.Mock };
  let queue: { add: jest.Mock };

  const parkedRun = (over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } }) => ({
    id: 1,
    puzzleId: 10,
    trialNumber: 0,
    strategyName: "llm-openrouter",
    modelName: "z-ai/glm-5.2:free",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  });

  beforeEach(async () => {
    strategyRunRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    };
    holdService = {
      clearExpired: jest.fn().mockResolvedValue({ clearedModels: [], clearedAccountWide: true }),
      isHeld: jest.fn().mockResolvedValue(false),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenRouterRpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: RateLimitHoldService, useValue: holdService },
        { provide: LLM_OPENROUTER_QUEUE, useValue: queue },
      ],
    }).compile();

    service = module.get(OpenRouterRpdResumeService);
  });

  afterEach(() => jest.clearAllMocks());

  it("clears the expired hold and re-dispatches every parked llm-openrouter run", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 1, puzzle: { date: "2026-01-02" } }),
    ]);

    const result = await service.runResume();

    expect(holdService.clearExpired).toHaveBeenCalled();
    expect(strategyRunRepo.save).toHaveBeenCalledTimes(2);
    expect(strategyRunRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: StrategyRunStatus.RUNNING }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "run-strategy",
      expect.objectContaining({ strategyName: "llm-openrouter", puzzleId: 10, date: "2026-01-01" }),
      { jobId: expect.stringMatching(new RegExp(`^${runStrategyJobId(10, "llm-openrouter", 0)}-resume-`)) },
    );
    expect(result).toEqual({ cleared: true, redispatched: 2 });
  });

  it("re-dispatches nothing while the account hold is still live", async () => {
    holdService.clearExpired.mockResolvedValue({ clearedModels: [], clearedAccountWide: false });
    holdService.isHeld.mockResolvedValue(true);
    strategyRunRepo.find.mockResolvedValue([parkedRun({ puzzle: { date: "2026-01-01" } })]);

    const result = await service.runResume();

    expect(queue.add).not.toHaveBeenCalled();
    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: false, redispatched: 0 });
  });

  it("uses one stamp for every run in a sweep and an id distinct from the run's original job id", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 0, puzzle: { date: "2026-01-02" } }),
    ]);

    await service.runResume();

    const firstId = queue.add.mock.calls[0][2].jobId as string;
    const secondId = queue.add.mock.calls[1][2].jobId as string;
    expect(firstId.split("-resume-")[1]).toBe(secondId.split("-resume-")[1]);
    expect(firstId).not.toBe(runStrategyJobId(10, "llm-openrouter", 0));
  });

  it("leaves a run parked when its enqueue fails", async () => {
    queue.add.mockRejectedValueOnce(new Error("redis down"));
    strategyRunRepo.find.mockResolvedValue([parkedRun({ puzzle: { date: "2026-01-01" } })]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("does nothing when there are no parked runs", async () => {
    const result = await service.runResume();

    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: true, redispatched: 0 });
  });
});
