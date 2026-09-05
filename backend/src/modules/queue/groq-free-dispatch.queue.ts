import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the Groq free-daily-quota dispatch cycle (see
// GroqFreeDispatchService) — the Groq counterpart to
// google-free-dispatch.queue.ts. Each job is one "tick": it checks which
// Groq models are currently RPD-held, queues the next batch of trials
// against whichever models are free, and (unless the cycle is done)
// schedules its own successor tick.
export const groqFreeDispatchQueue = new Queue("groq-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
