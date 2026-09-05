import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the Mistral hold resume (see MistralRpdResumeService /
// MistralRpdResumeBootstrap). Like groq-rpd-resume.queue.ts, no fixed
// schedule is registered against this queue — MistralRpdResumeBootstrap
// only enqueues one startup catch-up job; every job after that is a
// self-scheduled "rearm" from MistralRpdResumeService.runResume() targeting
// the soonest live hold's resetAt.
export const mistralRpdResumeQueue = new Queue("mistral-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
