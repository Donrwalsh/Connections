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
import { ModelMetadataRefreshService } from "./modules/supported-model/model-metadata-refresh.service";
import {
  isLlmStrategy,
  LLM_OPENAI,
  LLM_OLLAMA,
  LLM_GOOGLE,
  llmOllamaConcurrency,
  llmOpenAIConcurrency,
  llmGoogleConcurrency,
  STRATEGY_SET,
  workerRole,
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
  const role = workerRole();
  logger.log(`starting worker process with role='${role}'`);

  const appContext = await NestFactory.createApplicationContext(AppModule);
  const strategyService = appContext.get(StrategyService);
  const llmStrategyRunner = appContext.get(LlmStrategyRunner);
  const puzzleIngestionService = appContext.get(PuzzleIngestionService);
  const freeTierDispatchService = appContext.get(FreeTierDispatchService);
  const modelMetadataRefreshService = appContext.get(ModelMetadataRefreshService);

  const activeWorkers: Worker[] = [];
  const activeQueueNames: string[] = [];

  // role 'ollama' runs only the llm-ollama-runs queue (see createLlmWorker
  // below) — everything else in this file is skipped for that role.
  if (role !== "ollama") {
    const strategyRunsWorker = new Worker(
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

    strategyRunsWorker.on("completed", () => {
      // logger.log(`job ${job.id} completed`);  noisy
    });

    strategyRunsWorker.on("failed", (job, err) => {
      logger.error(`job ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(strategyRunsWorker);
    activeQueueNames.push("strategy-runs");
  }

  /**
   * A worker for one provider's LLM runs. Each provider gets its own queue and
   * its own concurrency, so llm-openai and llm-ollama runs never block each
   * other and each provider only overlaps with itself up to the configured
   * limit (default 1 = fully serialized). Concurrency is read once at boot.
   */
  const createLlmWorker = (
    queueName: "llm-openai-runs" | "llm-ollama-runs" | "llm-google-runs",
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

  // role 'ollama' runs ONLY this queue — that's the whole point of running a
  // worker on the machine hosting Ollama: it pulls just llm-ollama-runs over
  // an outbound connection to the deployed Redis/Postgres, so Ollama itself
  // never has to be reachable from outside the local network.
  if (role !== "cloud") {
    const llmOllamaWorker = createLlmWorker(
      "llm-ollama-runs",
      LLM_OLLAMA,
      llmOllamaConcurrency(),
    );
    activeWorkers.push(llmOllamaWorker);
    activeQueueNames.push("llm-ollama-runs");
  }

  // role 'ollama' skips everything below — no OpenAI runs, puzzle ingestion,
  // or free-tier dispatch on a worker that's only there to reach Ollama.
  if (role !== "ollama") {
    const llmOpenAIWorker = createLlmWorker(
      "llm-openai-runs",
      LLM_OPENAI,
      llmOpenAIConcurrency(),
    );
    activeWorkers.push(llmOpenAIWorker);
    activeQueueNames.push("llm-openai-runs");

    const llmGoogleWorker = createLlmWorker(
      "llm-google-runs",
      LLM_GOOGLE,
      llmGoogleConcurrency(),
    );
    activeWorkers.push(llmGoogleWorker);
    activeQueueNames.push("llm-google-runs");

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

    activeWorkers.push(puzzleWorker);
    activeQueueNames.push("puzzle-population");

    const modelMetadataWorker = new Worker(
      "model-metadata-refresh",
      async (job) => {
        logger.log(`starting model-metadata refresh job ${job.id}`);
        const result = await modelMetadataRefreshService.refreshAll();
        logger.log(`finished model-metadata refresh job ${job.id}: ${JSON.stringify(result)}`);
        return result;
      },
      {
        connection: redisConnection,
        concurrency: 1,
      },
    );

    modelMetadataWorker.on("failed", (job, err) => {
      logger.error(`model-metadata refresh job ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(modelMetadataWorker);
    activeQueueNames.push("model-metadata-refresh");

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

    activeWorkers.push(freeTierDispatchWorker);
    activeQueueNames.push("free-tier-dispatch");
  }

  // Graceful shutdown: let BullMQ finish (or safely abandon, mid-transaction-safe)
  // the current job before the process exits, rather than getting killed
  // mid-write.
  const shutdown = async () => {
    logger.log("shutting down worker process...");
    await Promise.all(activeWorkers.map((w) => w.close()));
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.log(`listening for jobs on ${activeQueueNames.map((q) => `'${q}'`).join(", ")} queues`);
}

bootstrap();
