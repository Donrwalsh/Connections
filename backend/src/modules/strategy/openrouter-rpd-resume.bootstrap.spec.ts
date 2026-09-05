import { Queue } from "bullmq";
import { OpenRouterRpdResumeBootstrap } from "./openrouter-rpd-resume.bootstrap";

describe("OpenRouterRpdResumeBootstrap", () => {
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

  it("registers a daily 00:05 UTC resume scheduler", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new OpenRouterRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "openrouter-rpd-resume",
      { pattern: "5 0 * * *", tz: "UTC" },
      expect.objectContaining({ name: "resume-openrouter-rpd" }),
    );
  });

  it("enqueues one date-stamped startup catch-up sweep", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new OpenRouterRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("resume-openrouter-rpd");
    expect(data).toEqual({});
    expect((opts as { jobId: string }).jobId).toBe(
      `openrouter-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new OpenRouterRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
