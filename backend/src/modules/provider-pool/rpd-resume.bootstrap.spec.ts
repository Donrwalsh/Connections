import { Queue } from "bullmq";

import { RpdResumeBootstrap } from "./rpd-resume.bootstrap";
import type { ProviderPoolId } from "./provider-pool.config";

describe("RpdResumeBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queues: Map<ProviderPoolId, { upsertJobScheduler: jest.Mock; add: jest.Mock }>;

  const FREE_TIER: ProviderPoolId[] = ["google", "groq", "openrouter", "mistral", "sambanova"];
  const FIXED_CRON: Partial<Record<ProviderPoolId, { pattern: string; tz: string }>> = {
    google: { pattern: "1 0 * * *", tz: "America/Los_Angeles" },
    openrouter: { pattern: "5 0 * * *", tz: "UTC" },
  };

  beforeEach(() => {
    queues = new Map(
      FREE_TIER.map((id) => [
        id,
        { upsertJobScheduler: jest.fn().mockResolvedValue(undefined), add: jest.fn().mockResolvedValue(undefined) },
      ]),
    );
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  const run = async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new RpdResumeBootstrap(queues as unknown as ReadonlyMap<ProviderPoolId, Queue>);
    await bootstrap.onApplicationBootstrap();
  };

  it("enqueues exactly one date-stamped startup catch-up sweep per free-tier pool", async () => {
    await run();

    for (const id of FREE_TIER) {
      const q = queues.get(id)!;
      expect(q.add).toHaveBeenCalledTimes(1);
      const [name, data, opts] = q.add.mock.calls[0];
      expect(name).toBe(`resume-${id}-rpd`);
      expect(data).toEqual({});
      expect((opts as { jobId: string }).jobId).toBe(
        `${id}-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
      );
    }
  });

  it("registers a job scheduler only for the fixed-cron pools, on their pattern/tz", async () => {
    await run();

    expect(queues.get("google")!.upsertJobScheduler).toHaveBeenCalledWith(
      "google-rpd-resume",
      FIXED_CRON.google,
      expect.objectContaining({ name: "resume-google-rpd" }),
    );
    expect(queues.get("openrouter")!.upsertJobScheduler).toHaveBeenCalledWith(
      "openrouter-rpd-resume",
      FIXED_CRON.openrouter,
      expect.objectContaining({ name: "resume-openrouter-rpd" }),
    );
    for (const id of ["groq", "mistral", "sambanova"] as ProviderPoolId[]) {
      expect(queues.get(id)!.upsertJobScheduler).not.toHaveBeenCalled();
    }
  });

  it("skips all scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new RpdResumeBootstrap(queues as unknown as ReadonlyMap<ProviderPoolId, Queue>);

    await bootstrap.onApplicationBootstrap();

    for (const id of FREE_TIER) {
      expect(queues.get(id)!.add).not.toHaveBeenCalled();
      expect(queues.get(id)!.upsertJobScheduler).not.toHaveBeenCalled();
    }
  });
});
