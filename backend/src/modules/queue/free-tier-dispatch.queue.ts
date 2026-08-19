import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the free-tier dispatch cycle itself (see FreeTierDispatchService) —
// not the actual LLM solve work, which still goes through llm-openai-runs
// like any other dispatched trial. Each job on this queue is one "tick": it
// checks today's usage, queues the next batch of trials if there's safe
// headroom, and (unless the cycle is done) schedules its own successor tick
// after a delay — so this queue's job history is the cycle's audit trail.
export const freeTierDispatchQueue = new Queue("free-tier-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
