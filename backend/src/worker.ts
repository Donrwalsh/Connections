import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Worker, Job } from "bullmq";
import { AppModule } from "./app.module";
import { StrategyService } from "./modules/strategy/strategy.service";
import { redisConnection } from "./modules/queue/redis.config";
import { PuzzleIngestionService } from "./modules/game/puzzle-ingestion.service";

// Single source of truth for strategies
export const SUPPORTED_STRATEGIES = [
  "alphabetical",
  "reverse-alphabetical",
  "order",
  "reverse-order",
] as const;

export type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

const STRATEGY_SET = new Set<string>(SUPPORTED_STRATEGIES);

interface RunDeterministicStrategyJobData {
  puzzleId: number;
  strategyName: string;
  date: string;
}

async function bootstrap() {
  const logger = new Logger("Worker");
  const appContext = await NestFactory.createApplicationContext(AppModule);
  const strategyService = appContext.get(StrategyService);
  const puzzleIngestionService = appContext.get(PuzzleIngestionService);

  const worker = new Worker(
    "strategy-runs",
    async (job: Job<RunDeterministicStrategyJobData>) => {
      const { puzzleId, strategyName, date } = job.data;

      if (!STRATEGY_SET.has(strategyName)) {
        throw new Error(
          `Unsupported strategy '${strategyName}' passed to strategy-runs queue for puzzle ${puzzleId}`,
        );
      }

      logger.log(
        `starting job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName}`,
      );

      const result = await strategyService.runDeterministicStrategy(
        puzzleId,
        strategyName as SupportedStrategy,
      );

      logger.log(
        `finished job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} status=${result.status}`,
      );
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 5,
    },
  );

  worker.on("completed", (job) => {
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

  logger.log(
    "listening for jobs on 'strategy-runs' and 'puzzle-population' queues",
  );
}

bootstrap();
