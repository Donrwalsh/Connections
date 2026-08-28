import { Queue } from "bullmq";
import { GoogleRpdResumeBootstrap } from "./google-rpd-resume.bootstrap";

describe("GoogleRpdResumeBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { upsertJobScheduler: jest.Mock; add: jest.Mock };

  beforeEach(() => {
    queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("registers a daily 00:01 America/Los_Angeles resume scheduler", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new GoogleRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "google-rpd-resume",
      { pattern: "1 0 * * *", tz: "America/Los_Angeles" },
      expect.objectContaining({ name: "resume-google-rpd" }),
    );
  });

  it("enqueues one date-stamped startup catch-up sweep", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new GoogleRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("resume-google-rpd");
    expect(data).toEqual({});
    // Fixed per-day id so a backend and worker booting together dedupe to
    // one job rather than sweeping twice.
    expect((opts as { jobId: string }).jobId).toBe(
      `google-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new GoogleRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
