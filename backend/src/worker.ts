import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Worker, Job } from "bullmq";
import { AppModule } from "./app.module";
import { StrategyService } from "./modules/strategy/strategy.service";
import { LlmStrategyRunner } from "./modules/strategy/llm-strategy-runner.service";
import { FreeTierDispatchService } from "./modules/free-tier-dispatch/free-tier-dispatch.service";
import type { FreeTierId } from "./modules/strategy/free-tier-usage.service";
import { redisConnection } from "./modules/queue/redis.config";
import { PuzzleIngestionService } from "./modules/game/puzzle-ingestion.service";
import {
  isLlmStrategy,
  LLM_OPENAI,
  LLM_OLLAMA,
  llmOllamaConcurrency,
  llmOpenAIConcurrency,
  STRATEGY_SET,
} from "./strategies";

interface FreeTierDispatchTickJobData {
  tier: FreeTierId;
}

interface RunStrategyJobData {
  puzzleId: number;
  strategyName: string;
  date: string;
  trialNumber: number;
  // The dispatcher already validated this against the SupportedModel table
  // before enqueueing (StrategyService/PuzzleIngestionService) — null/absent
  // for non-LLM strategies, which don't have a model at all.
  model?: string | null;
}

async function bootstrap() {
  const logger = new Logger("Worker");
  const appContext = await NestFactory.createApplicationContext(AppModule);
  const strategyService = appContext.get(StrategyService);
  const llmStrategyRunner = appContext.get(LlmStrategyRunner);
  const puzzleIngestionService = appContext.get(PuzzleIngestionService);
  const freeTierDispatchService = appContext.get(FreeTierDispatchService);

  const worker = new Worker(
    "strategy-runs",
    async (job: Job<RunStrategyJobData>) => {
      const { puzzleId, strategyName, date, trialNumber, model } = job.data;

      if (!STRATEGY_SET.has(strategyName)) {
        throw new Error(
          `Unsupported strategy '${strategyName}' passed to strategy-runs queue for puzzle ${puzzleId}`,
        );
      }

      logger.log(
        `starting job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber}`,
      );

      const result = isLlmStrategy(strategyName)
        ? // Defensive: LLM jobs are normally routed to their per-provider
          // queues, but a stale job left on this queue before a deploy still
          // needs processing rather than failing forever.
          await llmStrategyRunner.runLlmStrategy(
            puzzleId,
            strategyName,
            trialNumber,
            model ?? undefined,
          )
        : await strategyService.runDeterministicStrategy(puzzleId, strategyName, trialNumber);

      logger.log(
        `finished job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber} status=${result.status}`,
      );
      return result;
    },
    {
      connection: redisConnection,
      // Deterministic/shuffle runs are CPU-bound and cheap — serialize them so
      // they never contend with each other's DB writes.
      concurrency: 1,
    },
  );

  worker.on("completed", () => {
    // logger.log(`job ${job.id} completed`);  noisy
  });

  worker.on("failed", (job, err) => {
    logger.error(`job ${job?.id} failed`, err?.stack || err);
  });

  /**
   * A worker for one provider's LLM runs. Each provider gets its own queue and
   * its own concurrency, so llm-openai and llm-ollama runs never block each
   * other and each provider only overlaps with itself up to the configured
   * limit (default 1 = fully serialized). Concurrency is read once at boot.
   */
  const createLlmWorker = (
    queueName: "llm-openai-runs" | "llm-ollama-runs",
    expectedStrategy: string,
    concurrency: number,
  ) => {
    const llmWorker = new Worker(
      queueName,
      async (job: Job<RunStrategyJobData>) => {
        const { puzzleId, strategyName, date, trialNumber, model } = job.data;

        if (strategyName !== expectedStrategy) {
          throw new Error(
            `Strategy '${strategyName}' dispatched to '${queueName}' queue for puzzle ${puzzleId}; expected '${expectedStrategy}'`,
          );
        }

        logger.log(
          `starting job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber}`,
        );

        const result = await llmStrategyRunner.runLlmStrategy(
          puzzleId,
          strategyName,
          trialNumber,
          model ?? undefined,
        );

        logger.log(
          `finished job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber} status=${result.status}`,
        );
        return result;
      },
      {
        connection: redisConnection,
        concurrency,
      },
    );

    llmWorker.on("failed", (job, err) => {
      logger.error(`job ${job?.id} failed`, err?.stack || err);
    });

    return llmWorker;
  };

  const llmOpenAIWorker = createLlmWorker("llm-openai-runs", LLM_OPENAI, llmOpenAIConcurrency());
  const llmOllamaWorker = createLlmWorker("llm-ollama-runs", LLM_OLLAMA, llmOllamaConcurrency());

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

  // Each job is one tick of a free-tier dispatch cycle (see
  // FreeTierDispatchService) — it queues this tick's batch onto
  // llm-openai-runs (processed by llmOpenAIWorker above, not here) and, if
  // the cycle should keep going, schedules its own successor tick. One at a
  // time: ticks self-chain with a delay, so there's never a reason to run
  // two concurrently.
  const freeTierDispatchWorker = new Worker(
    "free-tier-dispatch",
    async (job: Job<FreeTierDispatchTickJobData>) => {
      const { tier } = job.data;
      logger.log(`starting free-tier dispatch tick ${job.id}: tier=${tier}`);
      await freeTierDispatchService.runTick(tier);
      logger.log(`finished free-tier dispatch tick ${job.id}: tier=${tier}`);
    },
    {
      connection: redisConnection,
      concurrency: 1,
    },
  );

  freeTierDispatchWorker.on("failed", (job, err) => {
    logger.error(`free-tier dispatch tick ${job?.id} failed`, err?.stack || err);
  });

  // Graceful shutdown: let BullMQ finish (or safely abandon, mid-transaction-safe)
  // the current job before the process exits, rather than getting killed
  // mid-write.
  const shutdown = async () => {
    logger.log("shutting down worker process...");
    await Promise.all([
      worker.close(),
      llmOpenAIWorker.close(),
      llmOllamaWorker.close(),
      puzzleWorker.close(),
      freeTierDispatchWorker.close(),
    ]);
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.log(
    "listening for jobs on 'strategy-runs', 'llm-openai-runs', 'llm-ollama-runs', " +
      "'puzzle-population' and 'free-tier-dispatch' queues",
  );
}

bootstrap();
