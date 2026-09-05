import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GroqRpdResumeService } from "./groq-rpd-resume.service";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { GROQ_RPD_RESUME_QUEUE, LLM_GROQ_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";

describe("GroqRpdResumeService", () => {
  let service: GroqRpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; heldModels: jest.Mock; nextResetAt: jest.Mock };
  let queue: { add: jest.Mock };
  let resumeQueue: { add: jest.Mock };

  const parkedRun = (over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } }) => ({
    id: 1,
    puzzleId: 10,
    strategyName: "llm-groq",
    trialNumber: 0,
    modelName: "openai/gpt-oss-20b",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  });

  beforeEach(async () => {
    strategyRunRepo = { find: jest.fn().mockResolvedValue([]), save: jest.fn().mockResolvedValue(undefined) };
    holdService = {
      clearExpired: jest.fn().mockResolvedValue([]),
      heldModels: jest.fn().mockResolvedValue([]),
      nextResetAt: jest.fn().mockResolvedValue(null),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    resumeQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroqRpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: GroqRateLimitHoldService, useValue: holdService },
        { provide: LLM_GROQ_QUEUE, useValue: queue },
        { provide: GROQ_RPD_RESUME_QUEUE, useValue: resumeQueue },
      ],
    }).compile();

    service = module.get(GroqRpdResumeService);
  });

  afterEach(() => jest.clearAllMocks());

  it("revives parked runs whose model is no longer held and re-enqueues them", async () => {
    holdService.clearExpired.mockResolvedValue(["openai/gpt-oss-20b"]);
    holdService.heldModels.mockResolvedValue(["openai/gpt-oss-120b"]);
    holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 5 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: "openai/gpt-oss-20b", puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 1, modelName: "openai/gpt-oss-120b", puzzle: { date: "2026-01-02" } }),
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
        strategyName: "llm-groq",
        date: "2026-01-01",
        trialNumber: 0,
        model: "openai/gpt-oss-20b",
      },
      { jobId: expect.stringMatching(new RegExp(`^${runStrategyJobId(10, "llm-groq", 0)}-resume-`)) },
    );
    expect(result).toMatchObject({ cleared: ["openai/gpt-oss-20b"], redispatched: 1 });
  });

  // Regression: the original job for this run completed normally (the runner
  // *returns* when it parks, it does not throw) and llm-groq-runs keeps
  // completed job hashes around, so re-adding under the plain deterministic
  // id would be a silent BullMQ no-op and strand the run in RUNNING forever.
  it("re-enqueues under an id distinct from the run's original deterministic job id", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await service.runResume();

    const jobId = (queue.add.mock.calls[0][2] as { jobId: string }).jobId;
    expect(jobId).not.toBe(runStrategyJobId(10, "llm-groq", 0));
    expect(jobId.startsWith(`${runStrategyJobId(10, "llm-groq", 0)}-`)).toBe(true);
  });

  it("uses the same id for every run within one sweep, so a retried sweep collapses to one job", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await service.runResume();
    await service.runResume();

    const first = (queue.add.mock.calls[0][2] as { jobId: string }).jobId;
    const second = (queue.add.mock.calls[1][2] as { jobId: string }).jobId;
    expect(second).toBe(first);
  });

  it("leaves a run parked (not flipped to RUNNING) when the enqueue fails", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);
    queue.add.mockRejectedValue(new Error("redis down"));

    await expect(service.runResume()).rejects.toThrow("redis down");

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
  });

  it("skips a parked run with no modelName rather than dispatching an ungated Groq call", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: null, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(queue.add).not.toHaveBeenCalled();
    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("re-arms a delayed sweep when parked runs remain, capped at 15 minutes", async () => {
    holdService.heldModels.mockResolvedValue(["openai/gpt-oss-20b"]);
    holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 5 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(result.rearmedInMs).toBe(5 * 60_000);
    expect(resumeQueue.add).toHaveBeenCalledWith(
      "resume-groq-rpd",
      {},
      expect.objectContaining({ delay: 5 * 60_000, jobId: expect.stringContaining("rearm") }),
    );
  });

  it("caps the re-arm delay when the soonest reset is far away", async () => {
    holdService.heldModels.mockResolvedValue(["openai/gpt-oss-20b"]);
    holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 6 * 60 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(result.rearmedInMs).toBe(15 * 60_000);
  });

  it("does not re-arm when every parked run was revived", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(resumeQueue.add).not.toHaveBeenCalled();
    expect(result.rearmedInMs).toBeUndefined();
  });

  it("does nothing when there are no parked runs", async () => {
    holdService.clearExpired.mockResolvedValue([]);
    strategyRunRepo.find.mockResolvedValue([]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(resumeQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: [], redispatched: 0 });
  });
});
