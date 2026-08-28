import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GoogleRpdResumeService } from "./google-rpd-resume.service";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { GOOGLE_RPD_RESUME_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";

// 2026-01-15 12:00 PST — frozen so the Pacific date stamp baked into every
// resume job id is a literal in the assertions below.
const FROZEN_NOW = new Date("2026-01-15T20:00:00Z");
const PACIFIC_STAMP = "2026-01-15";

describe("GoogleRpdResumeService", () => {
  let service: GoogleRpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; heldModels: jest.Mock; nextResetAt: jest.Mock };
  let queue: { add: jest.Mock };
  let resumeQueue: { add: jest.Mock };

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
    holdService = {
      clearExpired: jest.fn().mockResolvedValue([]),
      heldModels: jest.fn().mockResolvedValue([]),
      nextResetAt: jest.fn().mockResolvedValue(null),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    resumeQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleRpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: GoogleRateLimitHoldService, useValue: holdService },
        { provide: LLM_GOOGLE_QUEUE, useValue: queue },
        { provide: GOOGLE_RPD_RESUME_QUEUE, useValue: resumeQueue },
      ],
    }).compile();

    service = module.get(GoogleRpdResumeService);

    // Frozen only *after* the Nest module compiles — installing fake timers
    // first also fakes setImmediate/nextTick, which compile() awaits.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }).setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("revives parked runs whose model is no longer held and re-enqueues them", async () => {
    holdService.clearExpired.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash-lite"]);
    holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 5 * 60_000));
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
      { jobId: `run-10-llm-google-0-resume-${PACIFIC_STAMP}` },
    );
    expect(result).toMatchObject({ cleared: ["gemini-3.6-flash"], redispatched: 1 });
  });

  // Regression: the original job for this run completed normally (the runner
  // *returns* when it parks, it does not throw) and llm-google-runs keeps
  // completed job hashes around, so re-adding under the plain deterministic
  // id would be a silent BullMQ no-op and strand the run in RUNNING forever.
  it("re-enqueues under an id distinct from the run's original deterministic job id", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await service.runResume();

    const jobId = (queue.add.mock.calls[0][2] as { jobId: string }).jobId;
    expect(jobId).not.toBe(runStrategyJobId(10, "llm-google", 0));
    expect(jobId.startsWith(`${runStrategyJobId(10, "llm-google", 0)}-`)).toBe(true);
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

  it("skips a parked run with no modelName rather than dispatching an ungated Google call", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: null, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(queue.add).not.toHaveBeenCalled();
    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("re-arms a delayed sweep when parked runs remain, capped at 15 minutes", async () => {
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 5 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(result.rearmedInMs).toBe(5 * 60_000);
    expect(resumeQueue.add).toHaveBeenCalledWith(
      "resume-google-rpd",
      {},
      expect.objectContaining({ delay: 5 * 60_000, jobId: expect.stringContaining("rearm") }),
    );
  });

  it("caps the re-arm delay when the soonest reset is far away", async () => {
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 6 * 60 * 60_000));
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
