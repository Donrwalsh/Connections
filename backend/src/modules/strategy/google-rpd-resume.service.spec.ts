import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GoogleRpdResumeService } from "./google-rpd-resume.service";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { LLM_GOOGLE_QUEUE } from "../queue/queue.module";

describe("GoogleRpdResumeService", () => {
  let service: GoogleRpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; heldModels: jest.Mock };
  let queue: { add: jest.Mock };

  const parkedRun = (over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } }) => ({
    id: 1,
    puzzleId: 10,
    strategyName: "llm-google",
    trialNumber: 0,
    modelName: "gemini-3.6-flash",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  });

  beforeEach(async () => {
    strategyRunRepo = { find: jest.fn().mockResolvedValue([]), save: jest.fn().mockResolvedValue(undefined) };
    holdService = { clearExpired: jest.fn().mockResolvedValue([]), heldModels: jest.fn().mockResolvedValue([]) };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleRpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: GoogleRateLimitHoldService, useValue: holdService },
        { provide: LLM_GOOGLE_QUEUE, useValue: queue },
      ],
    }).compile();

    service = module.get(GoogleRpdResumeService);
  });

  afterEach(() => jest.clearAllMocks());

  it("revives parked runs whose model is no longer held and re-enqueues them", async () => {
    holdService.clearExpired.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash-lite"]);
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: "gemini-3.6-flash", puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 1, modelName: "gemini-3.6-flash-lite", puzzle: { date: "2026-01-02" } }),
    ]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).toHaveBeenCalledTimes(1);
    expect(strategyRunRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: StrategyRunStatus.RUNNING }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "run-strategy",
      {
        puzzleId: 10,
        strategyName: "llm-google",
        date: "2026-01-01",
        trialNumber: 0,
        model: "gemini-3.6-flash",
      },
      { jobId: "run-10-llm-google-0" },
    );
    expect(result).toEqual({ cleared: ["gemini-3.6-flash"], redispatched: 1 });
  });

  it("does nothing when there are no parked runs", async () => {
    holdService.clearExpired.mockResolvedValue([]);
    strategyRunRepo.find.mockResolvedValue([]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: [], redispatched: 0 });
  });
});
