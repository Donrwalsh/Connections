// worker.ts
import { NestFactory } from "@nestjs/core";
import { Worker, Job } from "bullmq";
import { AppModule } from "./app.module";
import { StrategyService } from "./modules/strategy/strategy.service";
import { redisConnection } from "./modules/queue/redis.config";

interface RunDeterministicStrategyJobData {
  puzzleId: number;
  strategyName: string;
}

async function bootstrap() {
  const appContext = await NestFactory.createApplicationContext(AppModule);
  const strategyService = appContext.get(StrategyService);

  const worker = new Worker(
    "strategy-runs", // must match the queue name strategyQueue was created with
    async (job: Job<RunDeterministicStrategyJobData>) => {
      const { puzzleId, strategyName } = job.data;

      console.log(
        `[worker] starting job ${job.id}: puzzle=${puzzleId} strategy=${strategyName}`,
      );

      const result = await strategyService.runDeterministicStrategy(
        puzzleId,
        strategyName,
      );

      console.log(`[worker] finished job ${job.id}: status=${result.status}`);
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 2, // cap concurrent strategy runs; tune once you know real cost
    },
  );

  worker.on("completed", (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err);
  });

  // Graceful shutdown: let BullMQ finish (or safely abandon, mid-transaction-safe)
  // the current job before the process exits, rather than getting killed
  // mid-write. Matters most during dev, since tsx watch restarts this
  // container on every file save.
  const shutdown = async () => {
    console.log("[worker] shutting down...");
    await worker.close();
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("[worker] listening for jobs on 'strategy-runs' queue");
}

bootstrap();
