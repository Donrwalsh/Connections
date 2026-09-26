import type { Queue } from "bullmq";
import { LessThan } from "typeorm";

import { StaleRunSweepService, STALE_RUN_THRESHOLD_MS } from "./stale-run-sweep.service";
import { StrategyRunStatus } from "./entities/strategy-run.entity";
import type { ProviderPoolId } from "../provider-pool/provider-pool.config";

describe("StaleRunSweepService", () => {
  const realNodeEnv = process.env.NODE_ENV;
  const now = new Date("2026-09-24T12:00:00.000Z");

  const makeQueue = (name: string) => ({ name, add: jest.fn().mockResolvedValue(undefined) });
  let sharedQueue: ReturnType<typeof makeQueue>;
  let openaiQueue: ReturnType<typeof makeQueue>;
  let ollamaQueue: ReturnType<typeof makeQueue>;
  let repo: { find: jest.Mock };
  let service: StaleRunSweepService;

  const makeRun = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    puzzleId: 100,
    strategyName: "llm-openai",
    trialNumber: 2,
    modelName: "gpt-4.1-nano",
    status: StrategyRunStatus.RUNNING,
    puzzle: { date: "2026-09-01" },
    ...overrides,
  });

  beforeEach(() => {
    sharedQueue = makeQueue("strategy-runs");
    openaiQueue = makeQueue("llm-openai-runs");
    ollamaQueue = makeQueue("llm-ollama-runs");
    repo = { find: jest.fn().mockResolvedValue([]) };
    const byPool = new Map<ProviderPoolId, Queue>([
      ["openai", openaiQueue as unknown as Queue],
      ["ollama", ollamaQueue as unknown as Queue],
    ]);
    service = new StaleRunSweepService(
      repo as never,
      byPool as ReadonlyMap<ProviderPoolId, Queue>,
      sharedQueue as unknown as Queue,
    );
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("queries only RUNNING rows older than the staleness threshold", async () => {
    await service.sweep("all", now);

    const cutoff = new Date(now.getTime() - STALE_RUN_THRESHOLD_MS);
    expect(repo.find).toHaveBeenCalledWith({
      where: { status: StrategyRunStatus.RUNNING, updatedAt: LessThan(cutoff) },
      relations: { puzzle: true },
    });
  });

  it("re-enqueues a stale run on its provider queue with a date-stamped job id and no row write", async () => {
    repo.find.mockResolvedValue([makeRun()]);

    const result = await service.sweep("all", now);

    expect(result).toEqual({ resumed: 1, skipped: 0 });
    expect(openaiQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      {
        puzzleId: 100,
        strategyName: "llm-openai",
        date: "2026-09-01",
        trialNumber: 2,
        model: "gpt-4.1-nano",
      },
      { jobId: "run-100-llm-openai-gpt-4.1-nano-2-sweep-2026-09-24" },
    );
  });

  it("routes non-provider strategies to the shared strategy-runs queue", async () => {
    repo.find.mockResolvedValue([
      makeRun({ strategyName: "alphabetical", modelName: null, trialNumber: 0 }),
    ]);

    await service.sweep("cloud", now);

    expect(sharedQueue.add).toHaveBeenCalledTimes(1);
    expect(sharedQueue.add.mock.calls[0][2]).toEqual({
      jobId: "run-100-alphabetical-none-0-sweep-2026-09-24",
    });
  });

  describe("role scoping", () => {
    const rows = () => [
      makeRun({ id: 1 }),
      makeRun({ id: 2, strategyName: "llm-ollama", modelName: "qwen2.5:14b" }),
      makeRun({ id: 3, strategyName: "alphabetical", modelName: null, trialNumber: 0 }),
    ];

    it("cloud skips ollama-owned rows", async () => {
      repo.find.mockResolvedValue(rows());

      const result = await service.sweep("cloud", now);

      expect(result).toEqual({ resumed: 2, skipped: 1 });
      expect(ollamaQueue.add).not.toHaveBeenCalled();
    });

    it("ollama only resumes ollama-owned rows", async () => {
      repo.find.mockResolvedValue(rows());

      const result = await service.sweep("ollama", now);

      expect(result).toEqual({ resumed: 1, skipped: 2 });
      expect(ollamaQueue.add).toHaveBeenCalledTimes(1);
      expect(openaiQueue.add).not.toHaveBeenCalled();
      expect(sharedQueue.add).not.toHaveBeenCalled();
    });

    it("all resumes every row", async () => {
      repo.find.mockResolvedValue(rows());

      const result = await service.sweep("all", now);

      expect(result).toEqual({ resumed: 3, skipped: 0 });
    });
  });

  it("skips the sweep under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";

    await service.onApplicationBootstrap();

    expect(repo.find).not.toHaveBeenCalled();
  });
});
