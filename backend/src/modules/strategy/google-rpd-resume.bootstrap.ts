import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { GOOGLE_RPD_RESUME_QUEUE } from "../queue/queue.module";

// Schedules the daily Google RPD hold resume. Fires at 00:01 (not 00:00)
// America/Los_Angeles: the one-minute offset guarantees that by the time the
// sweep runs, every hold whose resetAt was the just-passed midnight is a
// full minute expired, so clearExpired clears it and Google's daily quota is
// definitely live again — no race with Google's own reset clock.
@Injectable()
export class GoogleRpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(GoogleRpdResumeBootstrap.name);

  constructor(@Inject(GOOGLE_RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping google-rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    // Run once immediately on startup to catch up on anything the 00:01
    // sweep missed — the worker being down at 00:01, or a hold whose resetAt
    // was still future then. Without this, a missed sweep leaves its parked
    // runs waiting a full further day. Fixed per-day jobId so a backend and
    // worker booting together resolve to the same job (see
    // PuzzleQueueBootstrap's startup-catch-up).
    await this.queue.add(
      "resume-google-rpd",
      {},
      {
        jobId: `google-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    await this.queue.upsertJobScheduler(
      "google-rpd-resume",
      { pattern: "1 0 * * *", tz: "America/Los_Angeles" },
      {
        name: "resume-google-rpd",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 5,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log('google-rpd-resume scheduled: "1 0 * * *" (America/Los_Angeles)');
  }
}
