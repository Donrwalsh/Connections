import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the SambaNova free-tier dispatch cycle (see
// SambaNovaFreeDispatchService) — the SambaNova counterpart to
// groq-free-dispatch.queue.ts. Each job is one "tick": it checks which
// SambaNova models are currently RPD-held, queues the next small batch of
// trials against whichever models are free, and (unless the cycle is done)
// schedules its own successor tick.
export const sambaNovaFreeDispatchQueue = new Queue("sambanova-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
