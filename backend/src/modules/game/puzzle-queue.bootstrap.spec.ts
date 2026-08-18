import { Test, TestingModule } from "@nestjs/testing";
import { PuzzleQueueBootstrap } from "./puzzle-queue.bootstrap";
import { PUZZLE_QUEUE } from "../queue/queue.module";

describe("PuzzleQueueBootstrap", () => {
  let bootstrap: PuzzleQueueBootstrap;
  let mockQueue: { add: jest.Mock; upsertJobScheduler: jest.Mock };
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PuzzleQueueBootstrap, { provide: PUZZLE_QUEUE, useValue: mockQueue }],
    }).compile();

    bootstrap = module.get<PuzzleQueueBootstrap>(PuzzleQueueBootstrap);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.clearAllMocks();
  });

  it("should never schedule anything while NODE_ENV=test (Jest's default)", async () => {
    process.env.NODE_ENV = "test";

    await bootstrap.onApplicationBootstrap();

    expect(mockQueue.add).not.toHaveBeenCalled();
    expect(mockQueue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("should queue a startup catch-up job and schedule the daily cron outside of test", async () => {
    process.env.NODE_ENV = "production";

    await bootstrap.onApplicationBootstrap();

    expect(mockQueue.add).toHaveBeenCalledWith(
      "populate-puzzles",
      {},
      expect.objectContaining({
        jobId: expect.stringContaining("startup-catch-up-"),
        removeOnComplete: true,
      }),
    );
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
      "daily-puzzle-population",
      expect.objectContaining({ pattern: expect.any(String) }),
      expect.objectContaining({ name: "populate-puzzles" }),
    );
  });
});
