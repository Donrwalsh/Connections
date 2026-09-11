import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";

import { RPD_RESUME_QUEUE_BY_POOL } from "../queue/queue.module";
import { FREE_TIER_POOLS, type ProviderPoolId } from "./provider-pool.config";

/**
 * Schedules the RPD hold resume sweep for every free-tier pool. Replaces the
 * five per-provider `*RpdResumeBootstrap` classes.
 *
 * Every pool gets one startup catch-up sweep (to revive anything that
 * expired while the process was down). A `fixed-cron` pool (google @ 00:01
 * Pacific, openrouter @ 00:05 UTC) additionally registers a job scheduler on
 * that cron. A `self-rearm` pool (groq, mistral, sambanova) has no fixed
 * time to align to — `RpdResumeService`'s own `rearm()` keeps the chain
 * alive, self-scheduling at the soonest live hold's resetAt.
 */
@Injectable()
export class RpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(RpdResumeBootstrap.name);

  constructor(
    @Inject(RPD_RESUME_QUEUE_BY_POOL)
    private readonly resumeQueueByPool: ReadonlyMap<ProviderPoolId, Queue>,
  ) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    for (const pool of FREE_TIER_POOLS) {
      const queue = this.resumeQueueByPool.get(pool.id)!;
      const jobOpts = {
        removeOnComplete: true as const,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential" as const, delay: 30000 },
      };

      // Fixed per-day jobId so a backend and worker booting together resolve
      // to the same catch-up job.
      await queue.add(
        `resume-${pool.id}-rpd`,
        {},
        {
          jobId: `${pool.id}-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
          ...jobOpts,
        },
      );

      const schedule = pool.freeTier.resetSchedule;
      if (schedule.kind === "fixed-cron") {
        await queue.upsertJobScheduler(
          `${pool.id}-rpd-resume`,
          { pattern: schedule.pattern, tz: schedule.tz },
          { name: `resume-${pool.id}-rpd`, data: {}, opts: jobOpts },
        );
        this.logger.log(
          `${pool.id}-rpd-resume scheduled: "${schedule.pattern}" (${schedule.tz})`,
        );
      } else {
        this.logger.log(
          `${pool.id}-rpd-resume: enqueued startup catch-up sweep (no fixed schedule — see rearm())`,
        );
      }
    }
  }
}
