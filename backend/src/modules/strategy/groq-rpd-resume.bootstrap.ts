import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { GROQ_RPD_RESUME_QUEUE } from "../queue/queue.module";

/**
 * Unlike GoogleRpdResumeBootstrap, this registers no fixed cron —
 * GroqRateLimitHold rows don't share one daily reset clock, so there's no
 * meaningful fixed time to align a sweep to. This only enqueues one
 * startup catch-up sweep (to revive anything that expired while the
 * process was down); GroqRpdResumeService.runResume()'s own rearm() call
 * keeps the chain alive afterward, self-scheduling at whichever live
 * hold's resetAt comes soonest. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class GroqRpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(GroqRpdResumeBootstrap.name);

  constructor(@Inject(GROQ_RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping groq-rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.add(
      "resume-groq-rpd",
      {},
      {
        jobId: `groq-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    this.logger.log("groq-rpd-resume: enqueued startup catch-up sweep (no fixed schedule — see rearm())");
  }
}
