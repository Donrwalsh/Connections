import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the Google free-daily-quota dispatch cycle (see
// GoogleFreeDispatchService) — the Google counterpart to
// free-tier-dispatch.queue.ts. Each job is one "tick": it checks which
// Google models are currently RPD-held, queues the next batch of trials
// against whichever models are free, and (unless the cycle is done)
// schedules its own successor tick.
export const googleFreeDispatchQueue = new Queue("google-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
