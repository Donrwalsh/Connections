import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";
import { LLM_OPENAI, LLM_OLLAMA } from "../../strategies";

export const strategyQueue = new Queue("strategy-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Per-provider queues for the LLM strategies. Splitting them off the shared
 * strategy-runs queue lets each provider's worker process runs at its own
 * configured concurrency, so llm-openai and llm-ollama runs never block each
 * other — and the deterministic strategies are never delayed behind an LLM
 * call (which can take minutes).
 */
export const llmOpenAIQueue = new Queue("llm-openai-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmOllamaQueue = new Queue("llm-ollama-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Routes a strategy run to the queue that processes it: the two LLM
 * strategies get their per-provider queues, everything else stays on the
 * shared strategy-runs queue. The only place the strategy->queue mapping
 * lives, so enqueue call sites stay provider-agnostic.
 */
export function queueForStrategy(
  defaultQueue: Queue,
  openAIQueue: Queue,
  ollamaQueue: Queue,
  strategyName: string,
): Queue {
  if (strategyName === LLM_OPENAI) return openAIQueue;
  if (strategyName === LLM_OLLAMA) return ollamaQueue;
  return defaultQueue;
}

/**
 * Deterministic job id for a strategy run so that duplicate enqueues of the
 * same (puzzle, strategy, trial) collapse to a single BullMQ job.
 */
export function runStrategyJobId(
  puzzleId: number | string,
  strategyName: string,
  trialNumber: number,
): string {
  return `run-${puzzleId}-${strategyName}-${trialNumber}`;
}
