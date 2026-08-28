import { Queue } from "bullmq";
import { GoogleRpdResumeBootstrap } from "./google-rpd-resume.bootstrap";

describe("GoogleRpdResumeBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { upsertJobScheduler: jest.Mock };

  beforeEach(() => {
    queue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
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

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new GoogleRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });
});
