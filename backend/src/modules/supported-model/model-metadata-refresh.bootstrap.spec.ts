import { Queue } from "bullmq";
import { ModelMetadataRefreshBootstrap } from "./model-metadata-refresh.bootstrap";

describe("ModelMetadataRefreshBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { add: jest.Mock; upsertJobScheduler: jest.Mock };

  beforeEach(() => {
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("registers the daily cron scheduler", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new ModelMetadataRefreshBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "daily-model-metadata-refresh",
      expect.objectContaining({ pattern: "0 7 * * *" }),
      expect.objectContaining({ name: "refresh-model-metadata" }),
    );
  });

  it("enqueues one date-stamped startup catch-up refresh", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new ModelMetadataRefreshBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("refresh-model-metadata");
    expect(data).toEqual({});
    // Fixed per-day id so a backend and worker booting together (or a
    // same-day redeploy) dedupe to one refresh rather than doubling up.
    expect((opts as { jobId: string }).jobId).toBe(
      `model-metadata-refresh-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new ModelMetadataRefreshBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });
});
