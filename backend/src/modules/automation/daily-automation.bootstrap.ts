import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { DAILY_AUTOMATION_QUEUE } from "../queue/queue.module";
import { DAILY_AUTOMATION_CRON } from "../../strategies";

/**
 * Schedules the daily free-tier-automation chain at 00:15 UTC — a
 * quarter-hour after the OpenAI mini/nano tier's UTC-midnight usage window
 * resets, so DailyAutomationService.run() always sees a fresh day's budget.
 * Also enqueues a startup catch-up run (fixed per-UTC-day jobId) so a
 * backend/worker that was down at 00:15 still gets the day's automation,
 * the same pattern GoogleRpdResumeBootstrap uses for its own daily sweep.
 * The catch-up run carries `{ skipJudgeLeg: true }` so a redeploy never
 * re-triggers the category-judge batch — that leg belongs only to the
 * scheduled cron run (see DailyAutomationService.run).
 */
@Injectable()
export class DailyAutomationBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(DailyAutomationBootstrap.name);

  constructor(@Inject(DAILY_AUTOMATION_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping daily-automation scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.add(
      "run-daily-automation",
      { skipJudgeLeg: true },
      {
        jobId: `daily-automation-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    await this.queue.upsertJobScheduler(
      "daily-automation",
      { pattern: DAILY_AUTOMATION_CRON, tz: "UTC" },
      {
        name: "run-daily-automation",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 3,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log(`daily-automation scheduled: "${DAILY_AUTOMATION_CRON}" (UTC)`);
  }
}
