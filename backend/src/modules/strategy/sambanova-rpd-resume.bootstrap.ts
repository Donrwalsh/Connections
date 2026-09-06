import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { SAMBANOVA_RPD_RESUME_QUEUE } from "../queue/queue.module";

/**
 * Unlike GoogleRpdResumeBootstrap, this registers no fixed cron —
 * SambaNovaRateLimitHold rows carry a per-hit reset duration with no shared
 * clock boundary, so there's no meaningful fixed time to align a sweep to.
 * This only enqueues one startup catch-up sweep (to revive anything that
 * expired while the process was down);
 * SambaNovaRpdResumeService.runResume()'s own rearm() call keeps the chain
 * alive afterward, self-scheduling at whichever live hold's resetAt comes
 * soonest. See
 * docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §6.
 */
@Injectable()
export class SambaNovaRpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(SambaNovaRpdResumeBootstrap.name);

  constructor(@Inject(SAMBANOVA_RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping sambanova-rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.add(
      "resume-sambanova-rpd",
      {},
      {
        jobId: `sambanova-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    this.logger.log(
      "sambanova-rpd-resume: enqueued startup catch-up sweep (no fixed schedule — see rearm())",
    );
  }
}
