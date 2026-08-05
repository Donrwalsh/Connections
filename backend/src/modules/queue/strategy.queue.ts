import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

export const strategyQueue = new Queue("strategy-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Deterministic job id for a strategy run so that duplicate enqueues of the
 * same (puzzle, strategy, trial) collapse to a single BullMQ job.
 */
export function runStrategyJobId(
  puzzleId: number | string,
  strategyName: string,
  trialNumber: number,
): string {
  return `run-${puzzleId}-${strategyName}-${trialNumber}`;
}
