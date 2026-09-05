import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { RPD_RESUME_QUEUE } from "../queue/queue.module";

// Schedules the daily RPD hold resume. Fires at 00:01 (not 00:00) per
// strategy's reset zone: 00:01 America/Los_Angeles for llm-google, 00:01 UTC
// for llm-groq. The one-minute offset guarantees that by the time the sweep
// runs, every hold whose resetAt was the just-passed midnight is a full
// minute expired, so clearExpired clears it and the daily quota is definitely
// live again — no race with the provider's own reset clock. Both schedules
// fire the same resume-rpd job, which sweeps every RPD strategy.
@Injectable()
export class RpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(RpdResumeBootstrap.name);

  constructor(@Inject(RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    // Run once immediately on startup to catch up on anything the 00:01
    // sweeps missed — the worker being down at 00:01, or a hold whose
    // resetAt was still future then. Without this, a missed sweep leaves its
    // parked runs waiting a full further day. Fixed per-day jobId so a
    // backend and worker booting together resolve to the same job (see
    // PuzzleQueueBootstrap's startup-catch-up).
    await this.queue.add(
      "resume-rpd",
      {},
      {
        jobId: `rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    await this.queue.upsertJobScheduler(
      "rpd-resume-google",
      { pattern: "1 0 * * *", tz: "America/Los_Angeles" },
      {
        name: "resume-rpd",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 5,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    await this.queue.upsertJobScheduler(
      "rpd-resume-groq",
      { pattern: "1 0 * * *", tz: "UTC" },
      {
        name: "resume-rpd",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 5,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log('rpd-resume scheduled: "1 0 * * *" (America/Los_Angeles) + "1 0 * * *" (UTC)');
  }
}
