import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

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
 * configured concurrency, so llm-openai, llm-ollama, and llm-google runs
 * never block each other — and the deterministic strategies are never
 * delayed behind an LLM call (which can take minutes).
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

export const llmGoogleQueue = new Queue("llm-google-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmGroqQueue = new Queue("llm-groq-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmOpenRouterQueue = new Queue("llm-openrouter-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmMistralQueue = new Queue("llm-mistral-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmSambaNovaQueue = new Queue("llm-sambanova-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmNvidiaQueue = new Queue("llm-nvidia-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

// Pure routing/naming helpers (queueForStrategy, queueForJudgeProvider,
// categoryEvalJobId, runStrategyJobId) live in `strategy-queue.utils.ts` so
// importing them doesn't also construct the real queues above.
