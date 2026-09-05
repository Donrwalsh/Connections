import { Queue } from "bullmq";
import { DailyAutomationBootstrap } from "./daily-automation.bootstrap";

describe("DailyAutomationBootstrap", () => {
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

  it("registers a daily 00:15 UTC automation scheduler", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new DailyAutomationBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "daily-automation",
      { pattern: "15 0 * * *", tz: "UTC" },
      expect.objectContaining({ name: "run-daily-automation" }),
    );
  });

  it("enqueues one date-stamped startup catch-up run that skips the judge leg", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new DailyAutomationBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("run-daily-automation");
    expect(data).toEqual({ skipJudgeLeg: true });
    expect((opts as { jobId: string }).jobId).toBe(
      `daily-automation-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("leaves the scheduled cron run to include the judge leg", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new DailyAutomationBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    const [, , jobTemplate] = queue.upsertJobScheduler.mock.calls[0];
    expect((jobTemplate as { data: unknown }).data).toEqual({});
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new DailyAutomationBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
