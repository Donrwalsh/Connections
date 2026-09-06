import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the SambaNova per-model requests-per-day hold resume (see
// SambaNovaRpdResumeService / SambaNovaRpdResumeBootstrap). Like
// groq-rpd-resume.queue.ts and unlike google-rpd-resume.queue.ts, no fixed
// daily schedule is registered — SambaNovaRpdResumeBootstrap only enqueues
// one startup catch-up job; every job after that is a self-scheduled
// "rearm" from SambaNovaRpdResumeService.runResume() targeting the soonest
// live hold's own resetAt.
export const sambaNovaRpdResumeQueue = new Queue("sambanova-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
