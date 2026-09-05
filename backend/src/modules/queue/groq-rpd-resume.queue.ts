import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the Groq requests-per-day hold resume (see GroqRpdResumeService /
// GroqRpdResumeBootstrap). Unlike google-rpd-resume.queue.ts, no fixed
// daily schedule is registered against this queue — GroqRpdResumeBootstrap
// only enqueues one startup catch-up job; every job after that is a
// self-scheduled "rearm" from GroqRpdResumeService.runResume() targeting
// the soonest live hold's own resetAt.
export const groqRpdResumeQueue = new Queue("groq-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
