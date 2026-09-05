import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { OPENROUTER_RPD_RESUME_QUEUE } from "../queue/queue.module";

/**
 * Registers the OpenRouter daily-hold resume sweep. Unlike
 * GroqRpdResumeBootstrap (no fixed schedule — Groq holds have per-hit
 * resets), OpenRouter's daily quota resets at a fixed UTC midnight, so this
 * is a plain daily cron at 00:05 UTC, mirroring GoogleRpdResumeBootstrap
 * (which uses Pacific). The five-minute offset guarantees any hold whose
 * resetAt was the just-passed UTC midnight is safely expired by the time
 * the sweep runs. Also enqueues one startup catch-up sweep to revive
 * anything that expired while the process was down. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §6.
 */
@Injectable()
export class OpenRouterRpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(OpenRouterRpdResumeBootstrap.name);

  constructor(@Inject(OPENROUTER_RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping openrouter-rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.add(
      "resume-openrouter-rpd",
      {},
      {
        jobId: `openrouter-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    await this.queue.upsertJobScheduler(
      "openrouter-rpd-resume",
      { pattern: "5 0 * * *", tz: "UTC" },
      {
        name: "resume-openrouter-rpd",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 5,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log('openrouter-rpd-resume scheduled: "5 0 * * *" (UTC) + startup catch-up');
  }
}
