import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the daily Google requests-per-day hold resume (see
// GoogleRpdResumeService / GoogleRpdResumeBootstrap). One scheduled job per
// day at 00:01 America/Los_Angeles: it clears expired GoogleRateLimitHold
// rows and re-dispatches every llm-google run parked at RATE_LIMITED_DAILY.
export const googleRpdResumeQueue = new Queue("google-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
