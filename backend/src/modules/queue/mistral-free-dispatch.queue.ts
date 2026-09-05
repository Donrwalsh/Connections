import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the Mistral free-dispatch cycle (see MistralFreeDispatchService) —
// the Mistral counterpart to groq-free-dispatch.queue.ts. Each job is one
// "tick": it checks which Mistral models are currently held, queues the next
// batch of trials against whichever models are free, and (unless the cycle
// is done) schedules its own successor tick.
export const mistralFreeDispatchQueue = new Queue("mistral-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
