import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { MODEL_METADATA_QUEUE } from "../queue/queue.module";

@Injectable()
export class ModelMetadataRefreshBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModelMetadataRefreshBootstrap.name);

  constructor(@Inject(MODEL_METADATA_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping model-metadata refresh scheduling (NODE_ENV=test)");
      return;
    }

    // Startup catch-up: refreshes immediately on every boot (fixed per-UTC-day
    // jobId, same pattern as DailyAutomationBootstrap/GoogleRpdResumeBootstrap),
    // so a fresh rollout — e.g. one that just migrated in new SupportedModel
    // rows — gets real metadata without waiting for the next 07:00 UTC cron
    // tick. This is a freshness convenience, not the ordering guarantee: that
    // guarantee comes from DailyAutomationService running its own
    // metadata-refresh leg in-process before any dispatch leg.
    await this.queue.add(
      "refresh-model-metadata",
      {},
      {
        jobId: `model-metadata-refresh-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    const cron = process.env.MODEL_METADATA_REFRESH_CRON || "0 7 * * *"; // 07:00 UTC, after puzzle population
    await this.queue.upsertJobScheduler(
      "daily-model-metadata-refresh",
      { pattern: cron, tz: process.env.PUZZLE_POPULATION_TZ || "UTC" },
      {
        name: "refresh-model-metadata",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 3,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log(`Model-metadata refresh scheduled: "${cron}"`);
  }
}
