import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { RpdResumeService } from "./rpd-resume.service";
import { RateLimitHoldService } from "./rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { RPD_RESUME_QUEUE, LLM_GOOGLE_QUEUE, LLM_GROQ_QUEUE } from "../queue/queue.module";
import { LLM_GOOGLE, LLM_GROQ } from "../../strategies";
import { runStrategyJobId } from "../queue/strategy.queue";

// 2026-01-15 12:00 PST — frozen so the Pacific date stamp baked into every
// resume job id is a literal in the assertions below (the UTC stamp for the
// groq sweep is the same date here, 2026-01-15).
const FROZEN_NOW = new Date("2026-01-15T20:00:00Z");
const PACIFIC_STAMP = "2026-01-15";

describe("RpdResumeService", () => {
  let service: RpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; heldModels: jest.Mock; nextResetAt: jest.Mock };
  let googleQueue: { add: jest.Mock };
  let groqQueue: { add: jest.Mock };
  let resumeQueue: { add: jest.Mock };

  const parkedRun = (
    over: Partial<Omit<StrategyRun, "puzzle">> & { puzzle: { date: string } },
  ) => ({
    id: 1,
    puzzleId: 10,
    strategyName: LLM_GOOGLE,
    trialNumber: 0,
    modelName: "gemini-3.6-flash",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  });

  // Only the google sweep sees the given runs; the groq sweep gets none, so
  // every test's enqueue/rove assertions stay focused on the strategy under
  // test.
  const googleCalls = (runs: ReturnType<typeof parkedRun>[]) => {
    strategyRunRepo.find.mockImplementation(async ({ where }) =>
      where.strategyName === LLM_GROQ ? [] : runs,
    );
  };

  beforeEach(async () => {
    strategyRunRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    };
    holdService = {
      clearExpired: jest.fn().mockResolvedValue([]),
      heldModels: jest.fn().mockResolvedValue([]),
      nextResetAt: jest.fn().mockResolvedValue(null),
    };
    googleQueue = { add: jest.fn().mockResolvedValue(undefined) };
    groqQueue = { add: jest.fn().mockResolvedValue(undefined) };
    resumeQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: RateLimitHoldService, useValue: holdService },
        { provide: LLM_GOOGLE_QUEUE, useValue: googleQueue },
        { provide: LLM_GROQ_QUEUE, useValue: groqQueue },
        { provide: RPD_RESUME_QUEUE, useValue: resumeQueue },
      ],
    }).compile();

    service = module.get(RpdResumeService);

    // Frozen only *after* the Nest module compiles — installing fake timers
    // first also fakes setImmediate/nextTick, which compile() awaits.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }).setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("revives parked google runs whose model is no longer held and re-enqueues them to llm-google-runs", async () => {
    holdService.clearExpired.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash-lite"]);
    holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 5 * 60_000));
    googleCalls([
      parkedRun({
        id: 1,
        puzzleId: 10,
        trialNumber: 0,
        modelName: "gemini-3.6-flash",
        puzzle: { date: "2026-01-01" },
      }),
      parkedRun({
        id: 2,
        puzzleId: 11,
        trialNumber: 1,
        modelName: "gemini-3.6-flash-lite",
        puzzle: { date: "2026-01-02" },
      }),
    ]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).toHaveBeenCalledTimes(1);
    expect(strategyRunRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: StrategyRunStatus.RUNNING }),
    );
    expect(googleQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      {
        puzzleId: 10,
        strategyName: LLM_GOOGLE,
        date: "2026-01-01",
        trialNumber: 0,
        model: "gemini-3.6-flash",
      },
      { jobId: `run-10-${LLM_GOOGLE}-0-resume-${PACIFIC_STAMP}` },
    );
    expect(groqQueue.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: ["gemini-3.6-flash"], redispatched: 1 });
  });

  it("revives parked groq runs whose model is no longer held and re-enqueues them to llm-groq-runs", async () => {
    holdService.heldModels.mockResolvedValue([]);
    strategyRunRepo.find.mockImplementation(async ({ where }) =>
      where.strategyName === LLM_GROQ
        ? [
            parkedRun({
              id: 3,
              puzzleId: 12,
              strategyName: LLM_GROQ,
              modelName: "llama-3.1-8b-instant",
              puzzle: { date: "2026-01-03" },
            }),
          ]
        : [],
    );

    const result = await service.runResume();

    expect(groqQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      {
        puzzleId: 12,
        strategyName: LLM_GROQ,
        date: "2026-01-03",
        trialNumber: 0,
        model: "llama-3.1-8b-instant",
      },
      expect.objectContaining({ jobId: `run-12-${LLM_GROQ}-0-resume-${PACIFIC_STAMP}` }),
    );
    expect(googleQueue.add).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(1);
  });

  // Regression: the original job for this run completed normally (the runner
  // *returns* when it parks, it does not throw) and the llm queue keeps
  // completed job hashes around, so re-adding under the plain deterministic
  // id would be a silent BullMQ no-op and strand the run in RUNNING forever.
  it("re-enqueues under an id distinct from the run's original deterministic job id", async () => {
    googleCalls([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await service.runResume();

    const jobId = (googleQueue.add.mock.calls[0][2] as { jobId: string }).jobId;
    expect(jobId).not.toBe(runStrategyJobId(10, LLM_GOOGLE, 0));
    expect(jobId.startsWith(`${runStrategyJobId(10, LLM_GOOGLE, 0)}-resume-`)).toBe(true);
  });

  it("uses the same id for every run within one sweep, so a retried sweep collapses to one job", async () => {
    googleCalls([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    await service.runResume();
    await service.runResume();

    const first = (googleQueue.add.mock.calls[0][2] as { jobId: string }).jobId;
    const second = (googleQueue.add.mock.calls[1][2] as { jobId: string }).jobId;
    expect(second).toBe(first);
  });

  it("leaves a run parked (not flipped to RUNNING) when the enqueue fails", async () => {
    googleCalls([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);
    googleQueue.add.mockRejectedValue(new Error("redis down"));

    await expect(service.runResume()).rejects.toThrow("redis down");

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
  });

  it("skips a parked run with no modelName rather than dispatching an ungated call", async () => {
    googleCalls([
      parkedRun({
        id: 1,
        puzzleId: 10,
        trialNumber: 0,
        modelName: null,
        puzzle: { date: "2026-01-01" },
      }),
    ]);

    const result = await service.runResume();

    expect(googleQueue.add).not.toHaveBeenCalled();
    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("re-arms a delayed sweep when parked runs remain, capped at 15 minutes", async () => {
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 5 * 60_000));
    googleCalls([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(result.rearmedInMs).toBe(5 * 60_000);
    expect(resumeQueue.add).toHaveBeenCalledWith(
      "resume-rpd",
      {},
      expect.objectContaining({ delay: 5 * 60_000, jobId: expect.stringContaining("rearm") }),
    );
  });

  it("caps the re-arm delay when the soonest reset is far away", async () => {
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.nextResetAt.mockResolvedValue(new Date(FROZEN_NOW.getTime() + 6 * 60 * 60_000));
    googleCalls([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
    ]);

    const result = await service.runResume();

    expect(result.rearmedInMs).toBe(15 * 60_000);
  });

  it("does not re-arm when every parked run was revived", async () => {
    googleCalls([
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
    expect(googleQueue.add).not.toHaveBeenCalled();
    expect(groqQueue.add).not.toHaveBeenCalled();
    expect(resumeQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: [], redispatched: 0 });
  });
});
