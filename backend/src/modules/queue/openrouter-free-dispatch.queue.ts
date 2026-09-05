import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the OpenRouter free-daily-budget dispatch cycle (see
// OpenRouterFreeDispatchService). Each job is one "tick": it checks the
// account-wide hold, counts today's logged OpenRouter API calls against the
// configured daily budget, queues the next small batch of trials, and
// (unless done) schedules its own successor tick.
export const openRouterFreeDispatchQueue = new Queue("openrouter-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
