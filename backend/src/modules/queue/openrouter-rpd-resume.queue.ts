import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the OpenRouter account-wide daily-hold resume (see
// OpenRouterRpdResumeService / OpenRouterRpdResumeBootstrap). A fixed
// 00:05 UTC daily schedule is registered against this queue by the
// bootstrap, plus one startup catch-up job — OpenRouter's daily quota
// resets on the UTC-midnight clock, so unlike groq-rpd-resume.queue.ts
// there is no self-scheduled per-hit rearm.
export const openRouterRpdResumeQueue = new Queue("openrouter-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
