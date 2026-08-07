import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Worker, Job } from "bullmq";
import { AppModule } from "./app.module";
import { StrategyService } from "./modules/strategy/strategy.service";
import { redisConnection } from "./modules/queue/redis.config";
import { PuzzleIngestionService } from "./modules/game/puzzle-ingestion.service";
import { LLM, STRATEGY_SET } from "./strategies";

interface RunStrategyJobData {
  puzzleId: number;
  strategyName: string;
  date: string;
  trialNumber: number;
}

async function bootstrap() {
  const logger = new Logger("Worker");
  const appContext = await NestFactory.createApplicationContext(AppModule);
  const strategyService = appContext.get(StrategyService);
  const puzzleIngestionService = appContext.get(PuzzleIngestionService);

  const worker = new Worker(
    "strategy-runs",
    async (job: Job<RunStrategyJobData>) => {
      const { puzzleId, strategyName, date, trialNumber } = job.data;

      if (!STRATEGY_SET.has(strategyName)) {
        throw new Error(
          `Unsupported strategy '${strategyName}' passed to strategy-runs queue for puzzle ${puzzleId}`,
        );
      }

      logger.log(
        `starting job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber}`,
      );

      const result =
        strategyName === LLM
          ? await strategyService.runLlmStrategy(puzzleId, strategyName, trialNumber)
          : await strategyService.runDeterministicStrategy(puzzleId, strategyName, trialNumber);

      logger.log(
        `finished job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber} status=${result.status}`,
      );
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 1, // serialize — only one strategy run at a time
    },
  );

  worker.on("completed", () => {
    // logger.log(`job ${job.id} completed`);  noisy
  });

  worker.on("failed", (job, err) => {
    logger.error(`job ${job?.id} failed`, err?.stack || err);
  });

  const puzzleWorker = new Worker(
    "puzzle-population",
    async (job) => {
      logger.log(`starting puzzle population job ${job.id}`);
      const result = await puzzleIngestionService.populateUntilCaughtUp();
      logger.log(`finished job ${job.id}: ${JSON.stringify(result)}`);
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 1, // serialize — this loop mutates "latest date" state, don't run two at once
    },
  );

  puzzleWorker.on("failed", (job, err) => {
    logger.error(`puzzle population job ${job?.id} failed`, err?.stack || err);
  });

  // Graceful shutdown: let BullMQ finish (or safely abandon, mid-transaction-safe)
  // the current job before the process exits, rather than getting killed
  // mid-write.
  const shutdown = async () => {
    logger.log("shutting down worker process...");
    await Promise.all([worker.close(), puzzleWorker.close()]);
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.log("listening for jobs on 'strategy-runs' and 'puzzle-population' queues");
}

bootstrap();
