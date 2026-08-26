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
