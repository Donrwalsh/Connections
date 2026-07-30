import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

export const strategyQueue = new Queue("strategy-runs", {
  connection: redisConnection,
});
