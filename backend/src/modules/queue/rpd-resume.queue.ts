import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the daily requests-per-day hold resume (see RpdResumeService /
// RpdResumeBootstrap). One scheduled job per RPD strategy per day (00:01
// America/Los_Angeles for llm-google, 00:01 UTC for llm-groq): it clears
// expired RateLimitHold rows and re-dispatches every run parked at
// RATE_LIMITED_DAILY on the strategy's own llm queue.
export const rpdResumeQueue = new Queue("rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
