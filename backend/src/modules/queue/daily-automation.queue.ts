import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the daily free-tier-automation chain (see DailyAutomationService /
// DailyAutomationBootstrap). One scheduled job per day at 00:15 UTC — after
// the OpenAI mini/nano tier's UTC-midnight usage window has reset — that
// enqueues the judge backlog and starts the mini/nano and Google burn
// cycles.
export const dailyAutomationQueue = new Queue("daily-automation", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: "exponential", delay: 30000 },
  },
});
