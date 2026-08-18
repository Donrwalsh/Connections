import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { PUZZLE_QUEUE } from "../queue/queue.module";

@Injectable()
export class PuzzleQueueBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(PuzzleQueueBootstrap.name);

  constructor(@Inject(PUZZLE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    // Never schedule real ingestion/cron jobs from a test process — even
    // with Redis isolation (REDIS_DB, see test/setup-env.ts) making these
    // invisible to a live worker, a test boot has no business registering
    // production scheduling at all. Jest sets NODE_ENV=test by default.
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping puzzle-population job scheduling (NODE_ENV=test)");
      return;
    }

    // Run once immediately on startup, to catch up on anything missed.
    // Fixed jobId => if backend and worker both fire this within the same
    // moment, BullMQ resolves them to the same job instead of duplicating it.
    await this.queue.add(
      "populate-puzzles",
      {},
      {
        jobId: `startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 30000, // 30s, then 1m, 2m, 4m, 8m
        },
      },
    );

    // Recurring daily run. upsertJobScheduler is safe to call from multiple
    // processes/on every restart — same schedulerId + pattern is a no-op.
    const cron = process.env.PUZZLE_POPULATION_CRON || "0 6 * * *"; // 06:00 UTC by default
    await this.queue.upsertJobScheduler(
      "daily-puzzle-population",
      { pattern: cron, tz: process.env.PUZZLE_POPULATION_TZ || "UTC" },
      {
        name: "populate-puzzles",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 5,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log(
      `Puzzle population scheduled: "${cron}" (${process.env.PUZZLE_POPULATION_TZ || "UTC"})`,
    );
  }
}
